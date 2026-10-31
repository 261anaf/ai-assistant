const form = document.querySelector('#chat-form');
const input = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const messageList = document.querySelector('#message-list');
const welcome = document.querySelector('#welcome');
const clearButton = document.querySelector('#clear-chat');
const newChatButton = document.querySelector('#new-chat');
const themeButton = document.querySelector('#theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const toast = document.querySelector('#toast');
const sidebar = document.querySelector('#sidebar');
const menuButton = document.querySelector('#menu-toggle');
const sidebarScrim = document.querySelector('#sidebar-scrim');
const suggestionButtons = document.querySelectorAll('.suggestion-card');

let busy = false;
let toastTimer;

function assistantAvatar() {
  const avatar = document.createElement('span');
  avatar.className = 'avatar avatar-assistant';
  avatar.setAttribute('aria-hidden', 'true');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2.8 14.4 9.6 21.2 12l-6.8 2.4L12 21.2l-2.4-6.8L2.8 12l6.8-2.4L12 2.8Z');
  icon.append(path);
  avatar.append(icon);
  return avatar;
}

function addMessage(role, text = '', options = {}) {
  const row = document.createElement('article');
  row.className = `message ${role}${options.error ? ' error' : ''}`;

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;
  if (options.streaming) content.classList.add('streaming');

  if (role === 'user') {
    const avatar = document.createElement('span');
    avatar.className = 'avatar avatar-user';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = 'Y';
    row.append(avatar, content);
  } else {
    row.append(assistantAvatar(), content);
  }

  messageList.append(row);
  welcome.hidden = true;
  row.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return content;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3000);
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  input.disabled = value;
  sendButton.setAttribute('aria-label', value ? 'Assistant is responding' : 'Send message');
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function readError(response) {
  try {
    const body = await response.json();
    return body.error || 'The request could not be completed.';
  } catch {
    return 'The request could not be completed.';
  }
}

async function sendMessage(message) {
  const text = message.trim();
  if (!text || busy) return;

  addMessage('user', text);
  input.value = '';
  resizeInput();
  setBusy(true);
  const assistantContent = addMessage('assistant', '', { streaming: true });
  let receivedText = '';
  let reader;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) throw new Error('Streaming is not supported by this browser.');
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      throw new Error('The server returned an unexpected response. Please try again.');
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';

      for (const event of events) {
        const lines = event.split('\n');
        const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error('The server returned an invalid response. Please try again.');
        }

        if (eventName === 'error') throw new Error(payload.error || 'The response was interrupted.');
        if (eventName === 'done') completed = true;
        if (payload.text) {
          receivedText += payload.text;
          assistantContent.textContent = receivedText;
          assistantContent.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
      }

      if (done) break;
    }

    if (!completed) throw new Error('The response ended before it was complete. Please try again.');
    if (!receivedText.trim()) throw new Error('The assistant returned an empty response. Please try again.');
  } catch (error) {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }
    const message = error instanceof TypeError
      ? 'Could not connect to the assistant. Check your connection and try again.'
      : error.message || 'Something went wrong. Please try again.';
    assistantContent.textContent = message;
    assistantContent.closest('.message').classList.add('error');
    if (receivedText) {
      showToast('Response interrupted. This message was not saved to conversation history.');
    }
  } finally {
    assistantContent.classList.remove('streaming');
    setBusy(false);
    input.focus();
  }
}

async function clearConversation() {
  if (busy) {
    showToast('Wait for the current response to finish first.');
    return;
  }

  try {
    const response = await fetch('/api/clear', { method: 'POST' });
    if (!response.ok) throw new Error(await readError(response));
    messageList.replaceChildren();
    welcome.hidden = false;
    input.focus();
    closeSidebar();
  } catch (error) {
    showToast(error.message || 'Could not clear the conversation.');
  }
}

async function restoreConversation() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error(await readError(response));
    const { messages } = await response.json();
    if (!Array.isArray(messages)) throw new Error('The conversation could not be restored.');
    for (const message of messages) {
      if (['user', 'model'].includes(message.role) && typeof message.text === 'string') {
        addMessage(message.role === 'model' ? 'assistant' : 'user', message.text);
      }
    }
  } catch (error) {
    showToast(error.message || 'Could not restore the conversation.');
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeColor.setAttribute('content', theme === 'dark' ? '#111318' : '#faf9f7');
  try {
    localStorage.setItem('assistant-theme', theme);
  } catch {
    // The app still works when browser storage is unavailable.
  }
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarScrim.classList.add('visible');
  menuButton.setAttribute('aria-expanded', 'true');
  menuButton.setAttribute('aria-label', 'Close navigation');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarScrim.classList.remove('visible');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open navigation');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(input.value);
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

clearButton.addEventListener('click', clearConversation);
newChatButton.addEventListener('click', clearConversation);
themeButton.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
menuButton.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});
sidebarScrim.addEventListener('click', closeSidebar);
suggestionButtons.forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt || ''));
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    clearConversation();
  }
  if (event.key === 'Escape') closeSidebar();
});

try {
  const savedTheme = localStorage.getItem('assistant-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') setTheme(savedTheme);
} catch {
  // Use the default theme when browser storage is unavailable.
}

restoreConversation();
