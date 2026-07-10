const API_BASE = 'https://platform-api2.max.ru';

export async function resolveChatId(token, { chatId, channelLink }) {
  if (chatId && /^-?\d+$/.test(String(chatId).trim())) return String(chatId).trim();
  const cleanLink = String(channelLink || '')
    .trim()
    .replace(/^https?:\/\/max\.ru\//i, '')
    .replace(/^@/, '')
    .replace(/^\/+|\/+$/g, '');
  if (!cleanLink) throw new Error('Не задан MAX_TARGET_CHAT_ID или MAX_CHANNEL_LINK');

  const response = await fetch(`${API_BASE}/chats/${encodeURIComponent(cleanLink)}`, {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Не удалось получить chat_id канала: MAX API ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  if (!data.chat_id) throw new Error('MAX не вернул chat_id. Проверьте ссылку канала и добавлен ли бот в канал.');
  if (data.status && data.status !== 'active') throw new Error(`Бот не активен в канале: status=${data.status}`);
  return String(data.chat_id);
}

export async function sendMaxMessage(token, chatId, text) {
  const url = new URL(`${API_BASE}/messages`);
  url.searchParams.set('chat_id', String(chatId));
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(text).slice(0, 4000),
      format: 'markdown',
      notify: true,
      disable_link_preview: true
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Не удалось отправить сообщение: MAX API ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}
