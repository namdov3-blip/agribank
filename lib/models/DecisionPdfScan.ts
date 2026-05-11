import mongoose, { Schema, Document, Types } from 'mongoose';

/** Bản scan PDF quyết định — lưu binary trong MongoDB (BSON tối đa ~16MB/file). */
export interface IDecisionPdfScan extends Document {
    organization: string;
    uploadedBy: Types.ObjectId;
    originalFileName: string;
    note?: string;
    pdfBuffer: Buffer;
    sizeBytes: number;
}

const DecisionPdfScanSchema = new Schema<IDecisionPdfScan>(
    {
        organization: { type: String, required: true, index: true },
        uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        originalFileName: { type: String, required: true },
        note: { type: String, default: '' },
        pdfBuffer: { type: Buffer, required: true },
        sizeBytes: { type: Number, required: true }
    },
    { timestamps: true }
);

DecisionPdfScanSchema.index({ organization: 1, createdAt: -1 });

DecisionPdfScanSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret: Record<string, unknown>) {
        delete ret.pdfBuffer;
        if (ret._id) {
            ret.id = (ret._id as Types.ObjectId).toString();
            delete ret._id;
        }
        return ret;
    }
});

const DecisionPdfScan =
    mongoose.models.DecisionPdfScan || mongoose.model<IDecisionPdfScan>('DecisionPdfScan', DecisionPdfScanSchema);
export default DecisionPdfScan as mongoose.Model<IDecisionPdfScan>;
