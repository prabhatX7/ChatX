import mongoose from 'mongoose';

// Small server-wide secrets that must survive restarts (for example the push-notification key pair).
const schema = new mongoose.Schema({ _id: String, value: mongoose.Schema.Types.Mixed });
export default mongoose.model('ServerKey', schema);
