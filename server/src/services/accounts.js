import User from '../models/User.js';
import RequestedUser from '../models/RequestedUser.js';

// Two kinds of account share one chat system: real users (User) and approved visitors (RequestedUser).
// Ids never collide in practice (ObjectIds), so an id alone tells us which collection to use.

/** Which model holds the account with this id? Visitors are rare, so check them first only when asked. */
export async function modelOf(id) {
  if (await User.exists({ _id: id })) return User;
  if (await RequestedUser.exists({ _id: id })) return RequestedUser;
  return null;
}

/** The model for a signed-in caller (the token says whether it is a visitor). */
export const modelForCaller = (req) => (req.isGuest ? RequestedUser : User);

/** Fetch one account from whichever collection holds it. */
export async function findAccount(id, fields) {
  return (await User.findById(id, fields).lean()) || (await RequestedUser.findById(id, fields).lean());
}

/** Is anyone's chat still pointing at this file? (Checks both collections.) */
export async function fileInUse(fileId) {
  return Boolean((await User.exists({ 'messages.fileId': fileId })) || (await RequestedUser.exists({ 'messages.fileId': fileId })));
}
