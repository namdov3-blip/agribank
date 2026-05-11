
import React, { useState } from 'react';
import { LayoutDashboard, FolderKanban, Users, LogOut, ShieldCheck, Landmark, Calculator, FileText } from 'lucide-react';
import { User } from '../types';
import { isSuperAdminOrAdminRole, isStaffEditingPolicyExempt } from '../utils/helpers';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  currentUser: User;
  onLogout?: () => void;
  editingAllowed?: boolean;
  onEditingAllowedChange?: (allowed: boolean) => Promise<void>;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  currentUser,
  onLogout,
  editingAllowed = true,
  onEditingAllowedChange
}) => {
  const [editingSaving, setEditingSaving] = useState(false);
  const menuItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Tổng quan' },
    { id: 'projects', icon: FolderKanban, label: 'Quản lý dự án' },
    { id: 'balance', icon: Landmark, label: 'Số dư' },
    { id: 'transactions', icon: Users, label: 'Giao dịch' },
    { id: 'interestCalc', icon: Calculator, label: 'Tính lãi dự kiến' },
    { id: 'pdf', icon: FileText, label: 'PDF' },
    { id: 'admin', icon: ShieldCheck, label: 'Admin' },
  ];

  // Filter menu items based on user permissions
  const availableItems = menuItems.filter(item => {
    // Chỉ SuperAdmin / Admin thấy mọi tab; Kế toán trưởng theo checklist permissions (kể cả tab Admin).
    if (isSuperAdminOrAdminRole(currentUser.role)) return true;
    // Tài khoản có quyền tab Admin nhưng role chưa cập nhật vẫn cần vào Dự án để duyệt template
    if (currentUser.permissions?.some((p) => String(p).trim().toLowerCase() === 'admin')) return true;
    // Allow interestCalc if user có quyền giao dịch hoặc số dư
    if (item.id === 'interestCalc') {
      return currentUser.permissions.includes('transactions') || currentUser.permissions.includes('balance') || currentUser.permissions.includes(item.id);
    }
    return currentUser.permissions.includes(item.id);
  });

  const canToggleStaffEditing = !!(
    onEditingAllowedChange && isStaffEditingPolicyExempt(currentUser.role, currentUser.permissions)
  );

  const setWorkspaceEditing = async (allowed: boolean) => {
    if (!onEditingAllowedChange || !canToggleStaffEditing) return;
    setEditingSaving(true);
    try {
      await onEditingAllowedChange(allowed);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Không cập nhật được';
      console.error('[Staff editing lock]', e);
      alert('Lỗi: ' + msg);
    } finally {
      setEditingSaving(false);
    }
  };

  return (
    <div className="w-64 h-screen fixed left-0 top-0 flex flex-col bg-white backdrop-blur-2xl border-r border-slate-200 z-40">
      <div className="p-8">
        <img 
          src="/agribank-logo.png"
          alt="Agribank Logo" 
          className="h-12 w-auto object-contain"
          onError={(e) => {
            // Fallback nếu logo không load được
            const target = e.target as HTMLImageElement;
            target.style.display = 'none';
            const fallback = document.createElement('div');
            fallback.className = 'text-2xl font-medium tracking-tight text-black';
            fallback.textContent = 'Agribank';
            target.parentElement?.appendChild(fallback);
          }}
        />
      </div>

      <nav className="flex-1 px-4 space-y-1 overflow-y-auto min-h-0">
        {availableItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`
              w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium transition-all duration-300
              ${activeTab === item.id 
                ? 'bg-blue-50 shadow-sm border border-blue-200 text-blue-700' 
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}
            `}
          >
            <item.icon size={18} strokeWidth={2} className={activeTab === item.id ? 'text-blue-600' : 'text-slate-500'} />
            {item.label}
          </button>
        ))}
      </nav>

      {!isStaffEditingPolicyExempt(currentUser.role, currentUser.permissions) && (
        <div className="px-4 pb-3 pt-2 mx-4 border border-slate-200 rounded-xl bg-white shadow-sm">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-wide mb-1">Trạng thái</p>
          <p className="text-sm font-black text-slate-800">
            {editingAllowed ? (
              <span className="text-emerald-700">Able</span>
            ) : (
              <span className="text-amber-800">Disable</span>
            )}
          </p>
          <p className="text-[10px] text-slate-500 mt-1 leading-snug">
            {editingAllowed
              ? 'Bạn có thể điều chỉnh dữ liệu (theo quyền từng tab).'
              : 'Hệ thống đang khóa chỉnh sửa — chỉ xem.'}
          </p>
        </div>
      )}

      {onEditingAllowedChange && canToggleStaffEditing && (
        <div className="px-4 pb-3 pt-2 mx-4 border border-slate-200 rounded-xl bg-slate-50/90 shadow-inner">
          <p className="text-[11px] font-black text-slate-700 leading-snug mb-1">Cho phép thực hiện thao tác</p>
          <p className="text-[11px] text-slate-600 mb-2">
            Hiện:{' '}
            <span className={`font-black ${editingAllowed ? 'text-emerald-700' : 'text-amber-800'}`}>
              {editingAllowed ? 'Able' : 'Disable'}
            </span>
          </p>
          <div className="flex gap-2 relative z-10">
            <button
              type="button"
              disabled={editingSaving}
              onClick={() => void setWorkspaceEditing(true)}
              title="Able — cho phép user thường chỉnh sửa / import"
              className="flex-1 px-2 py-2.5 rounded-lg bg-emerald-600 text-white text-[11px] font-black hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Able
            </button>
            <button
              type="button"
              disabled={editingSaving}
              onClick={() => void setWorkspaceEditing(false)}
              title="Disable — khóa import & chỉnh sửa (User1 / User2 / PMB)"
              className="flex-1 px-2 py-2.5 rounded-lg bg-slate-900 text-white text-[11px] font-black hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Disable
            </button>
          </div>
        </div>
      )}

      <div className="p-4 border-t border-slate-300 mx-4 mb-4">
        <div 
          onClick={onLogout}
          className="flex items-center gap-3 p-2 rounded-xl hover:bg-slate-50 border border-transparent hover:border-slate-200 transition-all cursor-pointer group"
        >
          <img src={currentUser.avatar} alt="User" className="w-9 h-9 rounded-full object-cover border border-white shadow-sm" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-slate-800 truncate">{currentUser.name}</p>
            <p className="text-[10px] font-medium text-slate-500 truncate">{currentUser.role}</p>
          </div>
          <LogOut size={16} className="text-slate-400 group-hover:text-red-500 transition-colors" strokeWidth={2} />
        </div>
      </div>
    </div>
  );
};
