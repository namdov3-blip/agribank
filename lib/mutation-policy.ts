import { VercelResponse } from '@vercel/node';
import connectDB from './mongodb';
import Settings from './models/Settings';
import Project from './models/Project';
import User from './models/User';
import Transaction from './models/Transaction';
import type { JWTPayload } from './auth';

export const ELEVATED_ROLES = ['SuperAdmin', 'Admin', 'ChiefAccountant'] as const;

export function isElevatedRole(role: string): boolean {
    const key = (role ?? '').trim().replace(/\s+/g, '').toLowerCase();
    return key === 'superadmin' || key === 'admin' || key === 'chiefaccountant';
}

/** Dự án đang khóa — không cho sửa/xóa/đổi trạng thái giao dịch (mọi vai trò). */
export function isProjectTransactionsLocked(project: { transactionsLocked?: boolean } | null | undefined): boolean {
    return project?.transactionsLocked === true;
}

/**
 * Chặn ghi nếu dự án đang khóa giao dịch. Dùng sau assertStaffMayMutate trên các API giao dịch.
 */
export async function assertProjectTransactionsUnlockedForWrite(
    projectId: string | { toString?: () => string } | null | undefined,
    res: VercelResponse
): Promise<boolean> {
    if (projectId == null || projectId === '') {
        res.status(400).json({ error: 'Thiếu dự án liên quan' });
        return false;
    }
    const idStr =
        typeof projectId === 'string'
            ? projectId
            : typeof (projectId as { toString?: () => string }).toString === 'function'
              ? (projectId as { toString: () => string }).toString()
              : '';
    if (!idStr) {
        res.status(400).json({ error: 'Thiếu dự án liên quan' });
        return false;
    }
    await connectDB();
    const project = await (Project as any).findById(idStr).select('transactionsLocked code').lean();
    if (!project) {
        res.status(404).json({ error: 'Không tìm thấy dự án' });
        return false;
    }
    if (isProjectTransactionsLocked(project)) {
        res.status(403).json({
            error: `Dự án "${(project as { code?: string }).code || idStr}" đang khóa chỉnh sửa giao dịch. Liên hệ Kế toán trưởng / Admin để mở khóa.`
        });
        return false;
    }
    return true;
}

/** Giao dịch import/merge chờ KTT duyệt — chặn mọi thao tác ghi cho đến khi duyệt tại Quản lý dự án. */
export function assertTransactionNotStaffImportPending(
    transaction: { staffImportPending?: boolean } | null | undefined,
    res: VercelResponse
): boolean {
    if (transaction && (transaction as { staffImportPending?: boolean }).staffImportPending === true) {
        res.status(403).json({
            error:
                'Giao dịch đang chờ duyệt import/merge — không được sửa, xóa hay đổi trạng thái cho đến khi Kế toán trưởng / Admin / SuperAdmin duyệt tại tab Quản lý dự án.'
        });
        return false;
    }
    return true;
}

/** undefined / missing trong DB được coi là true (backward compatible) */
export function isEditingAllowedFlag(value: unknown): boolean {
    return value !== false;
}

export async function getGlobalEditingAllowed(): Promise<boolean> {
    await connectDB();
    const doc = await (Settings as any).findOne({ key: 'global' }).lean();
    return isEditingAllowedFlag(doc?.editingAllowed);
}

/**
 * Staff (User1/User2/PMB) bị chặn khi editingAllowed=false. Elevated luôn được ghi.
 */
/** User được coi có quyền truy cập tính năng kiểu Admin (tab Admin) */
export function permissionsIncludeAdminTab(perms: unknown): boolean {
    if (!Array.isArray(perms)) return false;
    return perms.some((p: string) => String(p).trim().toLowerCase() === 'admin');
}

export async function assertStaffMayMutate(
    payload: JWTPayload,
    res: VercelResponse
): Promise<boolean> {
    if (isElevatedRole(payload.role)) {
        return true;
    }
    await connectDB();
    const op: any = await (User as any).findById(payload.userId).select('permissions').lean();
    if (permissionsIncludeAdminTab(op?.permissions)) {
        return true;
    }
    const allowed = await getGlobalEditingAllowed();
    if (!allowed) {
        res.status(403).json({
            error: 'Hệ thống đang khóa chỉnh sửa. Liên hệ Kế toán trưởng / Admin để được cấp quyền.'
        });
        return false;
    }
    return true;
}

/** Danh sách projectId (string) chưa duyệt template — dùng lọc số dư NH / giao dịch NH cho staff */
export async function getPendingTemplateProjectIds(
    payload: { role: string },
    currentUser: { organization?: string }
): Promise<string[]> {
    await connectDB();
    const q: Record<string, unknown> = { templateApproved: false };
    const r = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
    const isBroad =
        r === 'superadmin' || r === 'admin' || currentUser.organization === 'Nam World';
    if (!isBroad && currentUser.organization) {
        q.organization = currentUser.organization;
    }
    const rows = await (Project as any).find(q).select('_id').lean();
    return rows.map((r: any) => r._id.toString());
}

/**
 * ProjectId không tính vào báo cáo / các tab khác (trừ Quản lý dự án) — mọi vai trò:
 * - Dự án templateApproved=false
 * - Dự án có ít nhất một GD staffImportPending (merge chờ duyệt)
 */
export async function getStaffHiddenReportProjectIds(
    payload: { role: string },
    currentUser: { organization?: string }
): Promise<string[]> {
    await connectDB();

    const idSet = new Set<string>(await getPendingTemplateProjectIds(payload, currentUser));

    const r = (payload.role ?? '').trim().replace(/\s+/g, '').toLowerCase();
    const isBroad =
        r === 'superadmin' || r === 'admin' || currentUser.organization === 'Nam World';

    const pipeline: any[] = [
        { $match: { staffImportPending: true } },
        {
            $lookup: {
                from: 'projects',
                localField: 'projectId',
                foreignField: '_id',
                as: 'proj'
            }
        },
        { $unwind: '$proj' }
    ];
    if (!isBroad && currentUser.organization) {
        pipeline.push({ $match: { 'proj.organization': currentUser.organization } });
    }
    pipeline.push({ $group: { _id: '$projectId' } });

    const agg = await (Transaction as any).aggregate(pipeline).exec();
    for (const row of agg) {
        if (row._id) idSet.add(row._id.toString());
    }

    return [...idSet];
}
