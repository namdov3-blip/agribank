import mongoose, { Schema, Document } from 'mongoose';

export interface IInterestHistoryLog {
    timestamp: Date;
    oldRate: number;
    newRate: number;
    actor: string;
}

export interface ISettings extends Document {
    key: string;
    value: any;
    interestRate: number; // Current rate (for backward compatibility)
    interestRateChangeDate?: Date; // Ngày thay đổi lãi suất (ví dụ: 01/01/2026)
    interestRateBefore?: number; // Lãi suất trước mốc (ví dụ: 0.1%)
    interestRateAfter?: number; // Lãi suất sau mốc (ví dụ: 0.2%)
    interestHistory: IInterestHistoryLog[];
    bankOpeningBalance: number;
    bankInterestRate: number;
    lastBankInterestAccrued?: Date;
}

const InterestHistorySchema = new Schema<IInterestHistoryLog>({
    timestamp: { type: Date, default: Date.now },
    oldRate: { type: Number, required: true },
    newRate: { type: Number, required: true },
    actor: { type: String, required: true }
}, { _id: false });

const SettingsSchema = new Schema<ISettings>({
    key: { type: String, default: 'global', unique: true },
    interestRate: { type: Number, default: 6.5 },
    interestRateChangeDate: { type: Date }, // Ngày thay đổi lãi suất
    interestRateBefore: { type: Number }, // Lãi suất trước mốc (%)
    interestRateAfter: { type: Number }, // Lãi suất sau mốc (%)
    interestHistory: { type: [InterestHistorySchema], default: [] },
    bankOpeningBalance: { type: Number, default: 0 },
    bankInterestRate: { type: Number, default: 0.5 }, // Monthly interest rate
    lastBankInterestAccrued: { type: Date }
});

// Ensure virtual fields (like id) are serialized and _id is removed
SettingsSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (doc, ret) {
        if (ret._id) {
            ret.id = ret._id.toString();
            delete ret._id;
        }
        return ret;
    }
});

SettingsSchema.set('toObject', {
    virtuals: true,
    versionKey: false,
    transform: function (doc, ret) {
        if (ret._id) {
            ret.id = ret._id.toString();
            delete ret._id;
        }
        return ret;
    }
});

const Settings = mongoose.models.Settings || mongoose.model<ISettings>('Settings', SettingsSchema);
export default Settings as mongoose.Model<ISettings>;
