import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { BankTransaction, Settings, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { getStaffHiddenReportProjectIds } from '../../../lib/mutation-policy';
import mongoose from 'mongoose';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();

        // Get user's organization for filtering
        const currentUser = await (User as any).findById(payload.userId);
        if (!currentUser) {
            return res.status(401).json({ error: 'User not found' });
        }

        const orgFilter: any = {};
        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const skipOrgNarrow =
            roleKey === 'superadmin' || roleKey === 'admin' || currentUser.organization === 'Nam World';
        if (!skipOrgNarrow && currentUser.organization) {
            orgFilter.organization = currentUser.organization;
        }

        // Get settings for opening balance
        const settings = await (Settings as any).findOne({ key: 'global' });
        const openingBalance = settings?.bankOpeningBalance || 0;

        let totalDeposits = 0;
        let totalWithdrawals = 0;
        let currentBalance = openingBalance;
        let transactionCount = 0;

        const mongoFilter: any = { ...orgFilter };
        const pendingIds = await getStaffHiddenReportProjectIds(payload, currentUser);
        const pendingObjIds = pendingIds.map((i: string) => new mongoose.Types.ObjectId(i));
        mongoFilter.$or = [
            { projectId: { $exists: false } },
            { projectId: null },
            { projectId: { $nin: pendingObjIds } }
        ];
        const txs = await (BankTransaction as any).find(mongoFilter).sort({ date: 1, _id: 1 });
        transactionCount = txs.length;
        currentBalance = openingBalance;
        txs.forEach((tx: any) => {
            if (tx.amount > 0) {
                totalDeposits += tx.amount;
            } else {
                totalWithdrawals += Math.abs(tx.amount);
            }
            currentBalance += tx.amount;
        });

        return res.status(200).json({
            success: true,
            data: {
                openingBalance,
                currentBalance,
                reconciledBalance: currentBalance, // Set reconciledBalance same as currentBalance for now
                totalDeposits,
                totalWithdrawals,
                transactionCount,
                organization: currentUser.organization
            }
        });

    } catch (error: any) {
        console.error('Bank balance error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}

