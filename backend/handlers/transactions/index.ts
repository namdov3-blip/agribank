import { VercelRequest, VercelResponse } from '@vercel/node';
import connectDB from '../../../lib/mongodb';
import { Transaction, Project, User, AuditLog } from '../../../lib/models';
import mongoose from 'mongoose';
import { authMiddleware } from '../../../lib/auth';
import { getStaffHiddenReportProjectIds, isElevatedRole } from '../../../lib/mutation-policy';

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

        const { projectId, status, search, page = '1', limit = '50' } = req.query;

        let projectFilter: any = {};
        const roleKey = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
        const elevated = isElevatedRole(payload.role);
        const skipOrgNarrow =
            roleKey === 'superadmin' ||
            roleKey === 'admin' ||
            currentUser.organization === 'Nam World';
        if (!skipOrgNarrow && currentUser.organization) {
            projectFilter.organization = currentUser.organization;
        }
        /**
         * Staff: ẩn DA chờ duyệt template / merge chờ duyệt khỏi danh sách GD (báo cáo ổn định).
         * KTT / Admin / SuperAdmin: vẫn cần thấy GD staffImportPending để tab Quản lý dự án hiện nút duyệt.
         */
        const reportHiddenIds = elevated
            ? []
            : await getStaffHiddenReportProjectIds(payload, currentUser);
        const hiddenObjIds = reportHiddenIds.map((i) => new mongoose.Types.ObjectId(i));
        if (reportHiddenIds.length > 0) {
            projectFilter._id = { $nin: hiddenObjIds };
        }

        const orgAllowsProjectAccess = (proj: any): boolean => {
            if (!proj) return false;
            if (skipOrgNarrow) return true;
            if (!currentUser.organization) return false;
            return proj.organization === currentUser.organization;
        };

        let accessibleProjectIds: string[] = [];

        if (projectId) {
            const project = await (Project as any).findById(projectId);
            if (!project) {
                return res.status(404).json({ error: 'Project not found' });
            }
            if (!orgAllowsProjectAccess(project)) {
                return res.status(403).json({ error: 'Access denied to this project' });
            }
            if (!elevated) {
                const hiddenSet = new Set(reportHiddenIds);
                if (hiddenSet.has(project._id.toString())) {
                    return res.status(403).json({
                        error: 'Dự án chờ duyệt chỉ được xem ở tab Quản lý dự án'
                    });
                }
            }
            accessibleProjectIds = [projectId as string];
        } else {
            // Get all accessible projects
            const accessibleProjects = await (Project as any).find(projectFilter).select('_id');
            accessibleProjectIds = accessibleProjects.map((p: any) => p._id.toString());
        }

        // Build transaction filter
        const filter: any = {
            projectId: { $in: accessibleProjectIds }
        };

        if (status) {
            filter.status = status;
        }

        if (search && typeof search === 'string') {
            filter['household.name'] = { $regex: search, $options: 'i' };
        }

        if (!elevated) {
            filter.staffImportPending = { $ne: true };
        }

        const pageNum = parseInt(page as string) || 1;
        const rawLimit = parseInt(limit as string) || 50;
        // Cap at 10000 to prevent memory issues, but allow large bulk loads
        const limitNum = Math.min(rawLimit, 10000);
        const skip = (pageNum - 1) * limitNum;

        const [transactions, total] = await Promise.all([
            (Transaction as any).find(filter)
                .populate('projectId', 'code name interestStartDate organization templateApproved')
                .sort({ _id: 1 })
                .collation({ locale: 'en', numericOrdering: true })
                .skip(skip)
                .limit(limitNum),
            (Transaction as any).countDocuments(filter)
        ]);

        // Explicitly map _id to id for each transaction and its related project
        const mappedTransactions = transactions.map((t: any) => {
            const obj = t.toObject ? t.toObject({ virtuals: true }) : t;
            const mapped = {
                ...obj,
                id: (obj.id || obj._id || t._id || '').toString()
            };

            // Ensure projectId is returned as a string ID for frontend compatibility
            if (mapped.projectId) {
                if (typeof mapped.projectId === 'object') {
                    // Extract ID if populated
                    mapped.projectId = (mapped.projectId.id || mapped.projectId._id || '').toString();
                } else {
                    // Convert ObjectId to string
                    mapped.projectId = mapped.projectId.toString();
                }
            }

            // Ensure effectiveInterestDate is properly serialized if present
            if (mapped.effectiveInterestDate && mapped.effectiveInterestDate instanceof Date) {
                // Keep as Date object - JSON.stringify will convert to ISO string
                // No conversion needed, Mongoose toObject already handles this
            }

            return mapped;
        });

        return res.status(200).json({
            success: true,
            data: mappedTransactions,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });

    } catch (error: any) {
        console.error('Transactions API error:', error);
        return res.status(500).json({ error: 'Lỗi server: ' + error.message });
    }
}


