import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, Project, BankTransaction, Settings, User } from '../../../lib/models';
import { authMiddleware } from '../../../lib/auth';
import { calculateInterest, calculateInterestWithRateChange } from '../../../lib/utils/interest';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const payload = await authMiddleware(req, res);
        if (!payload) return;

        await connectDB();

        // Get user's organization for filtering
        const currentUser = await User.findById(payload.userId);
        if (!currentUser) {
            return res.status(401).json({ error: 'User not found' });
        }

        // Build organization filter
        const isAdmin = payload.role === 'Admin' || payload.role === 'SuperAdmin' || currentUser.organization === 'Nam World';
        const userOrg = currentUser.organization;
        const projectFilter: any = {};
        if (!isAdmin && userOrg) {
            projectFilter.organization = userOrg;
        }

        // Get settings
        // NOTE: Keep settingsDoc typed as the Mongoose document (or null) to avoid union-type property errors in TS.
        const settingsDoc = await Settings.findOne({ key: 'global' });
        const interestRate = settingsDoc?.interestRate ?? 6.5;
        const interestRateChangeDate = settingsDoc?.interestRateChangeDate;
        const interestRateBefore = settingsDoc?.interestRateBefore;
        const interestRateAfter = settingsDoc?.interestRateAfter;
        const hasRateChange = !!interestRateChangeDate &&
                              interestRateBefore !== null && interestRateBefore !== undefined &&
                              interestRateAfter !== null && interestRateAfter !== undefined;

        // GET - Calculate and return interest summary
        if (req.method === 'GET') {
            // Get all projects for this org
            const projects = await Project.find(projectFilter);
            const projectIds = projects.map(p => p._id);

            // Get all transactions for these projects
            const transactions = await Transaction.find({ projectId: { $in: projectIds } });

            const now = new Date();

            let pendingPrincipal = 0;
            let pendingInterest = 0;
            let lockedInterest = 0;
            let supplementary = 0;

            transactions.forEach(t => {
                const project = projects.find(p => p._id.toString() === t.projectId.toString());
                const baseDate = t.effectiveInterestDate || project?.interestStartDate;
                const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;

                if (t.status === 'Đã giải ngân' && t.disbursementDate) {
                    let interest = 0;
                    if (hasRateChange) {
                        const result = calculateInterestWithRateChange(
                            t.compensation.totalApproved,
                            baseDate,
                            new Date(t.disbursementDate),
                            interestRateChangeDate!,
                            interestRateBefore!,
                            interestRateAfter!
                        );
                        interest = result.totalInterest;
                    } else {
                        interest = calculateInterest(t.compensation.totalApproved, interestRate, baseDate, new Date(t.disbursementDate));
                    }
                    lockedInterest += interest;
                } else {
                    pendingPrincipal += principalBase;
                    let interest = 0;
                    if (hasRateChange) {
                        const result = calculateInterestWithRateChange(
                            principalBase,
                            baseDate,
                            now,
                            interestRateChangeDate!,
                            interestRateBefore!,
                            interestRateAfter!
                        );
                        interest = result.totalInterest;
                    } else {
                        interest = calculateInterest(principalBase, interestRate, baseDate, now);
                    }
                    pendingInterest += interest;
                    supplementary += t.supplementaryAmount || 0;
                }
            });

            // Get bank balance for this org
            const bankFilter: any = {};
            if (!isAdmin && userOrg) {
                bankFilter.organization = userOrg;
            }
            const lastBankTx = await BankTransaction.findOne(bankFilter).sort({ date: -1 });
            const bankBalance = lastBankTx?.runningBalance || 0;

            return res.status(200).json({
                success: true,
                data: {
                    organization: userOrg,
                    interestRate,
                    pendingPrincipal: Math.round(pendingPrincipal),
                    pendingInterest: Math.round(pendingInterest),
                    lockedInterest: Math.round(lockedInterest),
                    supplementary: Math.round(supplementary),
                    totalPending: Math.round(pendingPrincipal + pendingInterest + supplementary),
                    bankBalance: Math.round(bankBalance),
                    calculatedAt: now.toISOString()
                }
            });
        }

        // POST - Capitalize monthly interest (manual trigger or cron)
        if (req.method === 'POST') {
            if (payload.role !== 'Admin' && payload.role !== 'SuperAdmin') {
                return res.status(403).json({ error: 'Admin only' });
            }

            const { month, year } = req.body;
            const targetMonth = month || new Date().getMonth();
            const targetYear = year || new Date().getFullYear();

            // Calculate monthly interest for each org
            const orgs = ['Đông Anh', 'Phúc Thịnh', 'Thiên Lộc', 'Thư Lâm', 'Vĩnh Thanh'];
            const results: any[] = [];

            for (const org of orgs) {
                const orgProjects = await Project.find({ organization: org });
                const projectIds = orgProjects.map(p => p._id);

                const orgTransactions = await Transaction.find({
                    projectId: { $in: projectIds },
                    status: { $ne: 'Đã giải ngân' }
                });

                // Start/end of month
                const monthStart = new Date(targetYear, targetMonth, 1);
                const monthEnd = new Date(targetYear, targetMonth + 1, 0);

                let monthlyInterest = 0;
                orgTransactions.forEach(t => {
                    const project = orgProjects.find(p => p._id.toString() === t.projectId.toString());
                    const baseDate = t.effectiveInterestDate || project?.interestStartDate;
                    const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;

                    const effectiveStart = baseDate && new Date(baseDate) > monthStart ? new Date(baseDate) : monthStart;
                    let interest = 0;
                    if (hasRateChange) {
                        const result = calculateInterestWithRateChange(
                            principalBase,
                            effectiveStart,
                            monthEnd,
                            interestRateChangeDate!,
                            interestRateBefore!,
                            interestRateAfter!
                        );
                        interest = result.totalInterest;
                    } else {
                        interest = calculateInterest(principalBase, interestRate, effectiveStart, monthEnd);
                    }
                    monthlyInterest += interest;
                });

                if (monthlyInterest > 0) {
                    // Get current bank balance for this org
                    const lastTx = await BankTransaction.findOne({ organization: org }).sort({ date: -1 });
                    const currentBalance = lastTx?.runningBalance || 0;

                    // Create interest deposit transaction
                    await BankTransaction.create({
                        type: 'Nạp tiền',
                        amount: Math.round(monthlyInterest),
                        date: new Date(),
                        note: `Tự động kết chuyển lãi tháng ${targetMonth + 1}/${targetYear}`,
                        createdBy: 'Hệ thống',
                        runningBalance: currentBalance + Math.round(monthlyInterest),
                        organization: org,
                        updatedAt: new Date()
                    });

                    results.push({
                        organization: org,
                        monthlyInterest: Math.round(monthlyInterest),
                        newBalance: currentBalance + Math.round(monthlyInterest)
                    });
                }
            }

            return res.status(200).json({
                success: true,
                message: `Đã kết chuyển lãi tháng ${targetMonth + 1}/${targetYear}`,
                data: results
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error: any) {
        console.error('Interest calculation error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}

