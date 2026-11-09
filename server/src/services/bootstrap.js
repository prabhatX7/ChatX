import User from '../models/User.js';
import { config } from '../config.js';

/**
 * Runs on every start, after the database connects. Safe to run repeatedly.
 * The account whose email is ADMIN_EMAIL is the admin (and nobody else is).
 */
export async function bootstrap() {
  const promoted = await User.updateOne({ email: config.adminEmail }, { $set: { role: 'admin', group: null, status: 'active' } });
  if (promoted.matchedCount) {
    console.log(`Admin account: ${config.adminEmail}`);
  } else {
    console.log(
      `No account for ${config.adminEmail} yet. Sign up with that email and your ADMIN_SETUP_CODE to become the admin.`
    );
  }

  // If ADMIN_EMAIL is ever changed, the old admin goes back to being an ordinary member.
  const demoted = await User.updateMany(
    { role: 'admin', email: { $ne: config.adminEmail } },
    { $set: { role: 'member' } }
  );
  if (demoted.modifiedCount) {
    console.log(`ADMIN_EMAIL changed: ${demoted.modifiedCount} former admin account(s) are now ordinary members.`);
  }

  const waiting = await User.countDocuments({ status: 'pending' });
  if (waiting) console.log(`${waiting} sign-up request(s) are waiting for the admin's approval.`);
}
