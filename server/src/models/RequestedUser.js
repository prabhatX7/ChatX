import mongoose from 'mongoose';
import { messageSchema } from './User.js';

const { Schema } = mongoose;

// Someone who used "Send message request" without making an account (a visitor, for example from your portfolio).
// Stored in its own collection, away from real accounts. The visitor has no email or password: the browser makes a
// random secret, keeps it, and derives their login and encryption keys from it (like a password only they hold).
//
// A visitor can only ever chat with the admin, and only with text, voice notes and pictures (no calls).
// Their messages use exactly the same encrypted format as everyone else's.
const requestedUserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    authHash: { type: String, required: true }, // sha-256 of the client-derived auth secret (it is high entropy, so no bcrypt)
    publicKey: { type: String, required: true },
    encPrivateKey: {
      iv: { type: String, required: true },
      data: { type: String, required: true },
    },
    // 'pending' until the admin approves. A pending visitor cannot log in and nobody can see them.
    status: { type: String, enum: ['pending', 'active'], default: 'pending' },
    role: { type: String, default: 'guest' },
    // Becomes true once the first message (the request itself: contact + message, encrypted for the admin) is stored.
    introSent: { type: Boolean, default: false },
    theme: { type: String, enum: ['purple', 'blue'], default: 'purple' },
    themeChosen: { type: Boolean, default: false }, // false until they answer the colour popup
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true, collection: 'requestedusers' }
);

export default mongoose.models.RequestedUser || mongoose.model('RequestedUser', requestedUserSchema);
