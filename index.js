const { App, ExpressReceiver } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const cron = require('node-cron');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const NOTIFY_USER_ID = process.env.NOTIFY_USER_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ユーザー名をIDから解決する（失敗時はIDをそのまま返す）
async function getUserName(client, userId) {
  if (!userId) return '不明';
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user.profile;
    return profile.display_name || profile.real_name || profile.display_name_normalized || userId;
  } catch (e) {
    console.error(`ユーザー名取得失敗 (${userId}):`, e.message);
    console.error('→ Slack AppにOAuthスコープ "users:read" が付与されているか確認してください');
    return userId;
  }
}

// チャンネル名をIDから解決する（失敗時はIDをそのまま返す）
async function getChannelName(client, channelId) {
  if (!channelId) return '不明';
  try {
    const res = await client.conversations.info({ channel: channelId });
    return res.channel.name || channelId;
  } catch (e) {
    console.error(`チャンネル名取得失敗 (${channelId}):`, e.message);
    console.error('→ Slack AppにOAuthスコープ "channels:read" および "groups:read" が付与されているか確認してください');
    return channelId;
  }
}

function getSheetsClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function analyzeMessage(text, userName, channelName) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `あなたは木城拓也さん（経営者）のSlack報告モニターです。
以下のSlackメッセージを分析して、木城さんの対応が必要かどうか判定してください。

投稿者: ${userName}
チャンネル: ${channelName}
メッセージ: ${text}

以下のJSON形式のみで回答してください（他の文章は不要）：
{
  "needs_action": true or false,
  "summary": "30文字以内の要約",
  "action": "木城さんがやるべき具体的なアクション（不要なら空文字）",
  "urgency": "高 or 中 or 低",
  "importance": "高 or 中 or 低",
  "reason": "タスク化した理由（しない場合も理由を記載）"
}

タスク化する条件：
- 木城さんの判断・返信・承認が必要
- 期限がある
- トラブル・リスク・クレームが含まれる
- 売上・採用・契約・広告など経営インパクトがある

タスク化しない条件：
- 単なる共有・完了報告
- 雑談
- 木城さんの対応が不要なもの`
    }]
  });
  const content = response.content[0].text;
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

async function addToSheet(data) {
  const sheets = getSheetsClient();
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'タスク管理!A:O',
  });
  const rows = existing.data.values || [];
  const isDuplicate = rows.some(row => row[12] === data.slackUrl);
  if (isDuplicate) return false;
  const id = rows.length;
  const now = new Date().toLocaleDateString('ja-JP');
  const values = [[
    id, now, data.postDate, data.channelName, data.userName,
    data.summary, data.action, data.urgency, data.importance,
    '未着手', '', '木城', data.slackUrl, now, data.reason,
  ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'タスク管理!A:O',
    valueInputOption: 'RAW',
    resource: { values },
  });
  return true;
}

// メンション（@ボット）が届いたとき
app.event('app_mention', async ({ event, client }) => {
  console.log('app_mention イベント受信:', event.channel, event.user);
  try {
    const text = event.text;
    const ts = event.ts;
    const slackUrl = `https://slack.com/archives/${event.channel}/p${ts.replace('.', '')}`;
    const postDate = new Date(parseFloat(ts) * 1000).toLocaleDateString('ja-JP');

    const [userName, channelName] = await Promise.all([
      getUserName(client, event.user),
      getChannelName(client, event.channel),
    ]);

    console.log(`メンション処理: ${channelName} / ${userName}`);

    const analysis = await analyzeMessage(text, userName, channelName);
    if (analysis.needs_action) {
      const added = await addToSheet({ postDate, channelName, userName, summary: analysis.summary, action: analysis.action, urgency: analysis.urgency, importance: analysis.importance, slackUrl, reason: analysis.reason });
      console.log(added ? 'シートに追加しました' : '重複のためスキップ');
    } else {
      console.log('タスク化不要と判定:', analysis.reason);
    }
  } catch (error) {
    console.error('メンション処理エラー:', error);
  }
});

// 木城さんへのメンション or キーワードを含むメッセージを監視
app.event('message', async ({ event, client }) => {
  try {
    if (event.subtype || event.bot_id) return;
    const text = event.text || '';
    const keywords = ['確認お願い', '判断お願い', '承認お願い', '相談', 'クレーム', '緊急', '至急'];
    const hasKeyword = keywords.some(kw => text.includes(kw));
    const mentionsOwner = text.includes(`<@${NOTIFY_USER_ID}>`);
    if (!hasKeyword && !mentionsOwner) return;

    const ts = event.ts;
    const slackUrl = `https://slack.com/archives/${event.channel}/p${ts.replace('.', '')}`;
    const postDate = new Date(parseFloat(ts) * 1000).toLocaleDateString('ja-JP');

    const [userName, channelName] = await Promise.all([
      getUserName(client, event.user),
      getChannelName(client, event.channel),
    ]);

    const trigger = mentionsOwner ? '木城さんへのメンション' : 'キーワード';
    console.log(`${trigger}検知: ${channelName} / ${userName}`);

    const analysis = await analyzeMessage(text, userName, channelName);
    if (analysis.needs_action) {
      const added = await addToSheet({ postDate, channelName, userName, summary: analysis.summary, action: analysis.action, urgency: analysis.urgency, importance: analysis.importance, slackUrl, reason: analysis.reason });
      console.log(added ? 'シートに追加しました' : '重複のためスキップ');
    }
  } catch (error) {
    console.error('メッセージ処理エラー:', error);
  }
});

receiver.app.get('/', (req, res) => {
  res.send('AI報告モニター稼働中');
});

cron.schedule('0 13 * * *', async () => {
  console.log('日次通知を送信します');
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'タスク管理!A:O',
    });
    const rows = result.data.values || [];
    const today = new Date().toLocaleDateString('ja-JP');
    const todayTasks = rows.slice(1).filter(row => row[1] === today && row[9] === '未着手');
    const pendingHighTasks = rows.slice(1).filter(row => row[9] === '未着手' && row[7] === '高' && row[1] !== today);
    let message = `*【本日のAI報告モニター】*\n\n`;
    if (todayTasks.length > 0) {
      message += `*■ 今日追加された重要案件*\n`;
      todayTasks.forEach((row, i) => {
        message += `${i + 1}. ${row[5]}\n緊急度：${row[7]} ｜ 対応：${row[6]}\nリンク：${row[12]}\n\n`;
      });
    } else {
      message += `*■ 今日追加された重要案件*\nなし\n\n`;
    }
    if (pendingHighTasks.length > 0) {
      message += `*■ 未対応の高緊急度案件*\n`;
      pendingHighTasks.forEach(row => {
        message += `・${row[5]}（${row[2]}）\n`;
      });
    }
    await app.client.chat.postMessage({
      token: SLACK_BOT_TOKEN,
      channel: NOTIFY_USER_ID,
      text: message,
    });
    console.log('日次通知を送信しました');
  } catch (error) {
    console.error('通知エラー:', error);
  }
}, { timezone: 'Asia/Tokyo' });

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('AI報告モニター起動しました');
})();
