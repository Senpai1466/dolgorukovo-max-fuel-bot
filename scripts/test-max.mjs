import { resolveChatId, sendMaxMessage } from './max-api.mjs';

const token = required('MAX_BOT_TOKEN');
const chatId = await resolveChatId(token, {
  chatId: process.env.MAX_TARGET_CHAT_ID,
  channelLink: process.env.MAX_CHANNEL_LINK
});
await sendMaxMessage(token, chatId, '✅ **Проверка MAX-бота прошла успешно**\n\nКанал подключён. Теперь можно запускать проверку данных АЗС.');
console.log(`Тестовое сообщение отправлено в chat_id=${chatId}`);

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Не задан секрет ${name}`);
  return value;
}
