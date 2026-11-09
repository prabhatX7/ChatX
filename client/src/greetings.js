// A different hello every time the app opens, you sign up or log in.
// Same idea as the little greetings in chat apps: warm, a bit playful, never the same one twice in a row.

export const GREETINGS = [
  'Hey beautiful, hope this will be your refreshing chatting time.',
  'Welcome back. Your secrets are safe here.',
  "Let's talk. Nobody else is listening.",
  'Pour a coffee. Good conversations are on the way.',
  'Hello, stranger. Missed you.',
  'Private, encrypted and all yours.',
  'Good to see you. The chat is warm.',
  'Hey you. Say something nice today.',
  "Time to catch up. We'll keep it between us.",
  'Welcome to ChatX. Only you two can read this.',
  'Take a breath. Then say hi.',
  'Your people are waiting. Go on.',
  'A quiet corner of the internet, just for you.',
  'Hi there. May your messages always be seen.',
  'Fresh start, fresh chat. Make it a good one.',
  'Ready when you are.',
  'Hello, sunshine. Let the words flow.',
  'Locked, loaded and ready to chat.',
  "No ads, no spies, just friends. Let's go.",
  'Hey, you made it. Welcome in.',
  'Another day, another good conversation.',
  'Keep calm and chat on.',
  'Somebody is probably thinking of you right now.',
  'Hello again. Your keys never left this device.',
  'Make today a little warmer. Send a message.',
  'Good vibes only. Welcome.',
  'Words are better when they are private.',
  'Hi friend. Take your time, there is no rush here.',
  'The best part of the internet is the people. Say hi.',
  'Welcome. Your chat, your rules.',
  'Plot twist: nobody can read this but you two.',
  'Hey legend. Glad you are here.',
  'Breathe in, chat out.',
  'Hello, night owl. Or early bird. We do not judge.',
  'Your conversations, wrapped in violet.',
  'Smile, you are among friends.',
  'Hello. Let us make this a refreshing chat.',
  'Welcome home.',
  'Let the good talk begin.',
  'Hey there. Hope your day is going gently.',
];

const KEY = 'chatx_last_greeting';

/** A random greeting, never the same one as last time. `rand` is injectable for tests. */
export function pickGreeting(rand = Math.random, storage = safeStorage()) {
  let last = -1;
  try {
    last = Number(storage?.getItem(KEY));
  } catch {
    /* ignore */
  }
  let i = Math.floor(rand() * GREETINGS.length);
  if (i === last) i = (i + 1) % GREETINGS.length;
  try {
    storage?.setItem(KEY, String(i));
  } catch {
    /* ignore */
  }
  return GREETINGS[i];
}

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
