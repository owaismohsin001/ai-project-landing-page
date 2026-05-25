import mongoose, { Schema, model, models } from "mongoose";

/** An Enterprise enquiry submitted through the contact form. */
export interface IContact {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  company: string;
  message: string;
  createdAt: Date;
}

const contactSchema = new Schema<IContact>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    company: { type: String, trim: true, default: "" },
    message: { type: String, required: true, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Contact =
  (models.Contact as mongoose.Model<IContact>) ||
  model<IContact>("Contact", contactSchema);
