
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { HashRouter } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { TransactionList } from './pages/TransactionList';
import { TransactionModal } from './components/TransactionModal';
import { BankBalance } from './pages/BankBalance';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { ConfirmPage } from './pages/ConfirmPage';
import { InterestCalculator } from './pages/InterestCalculator';
import { PdfDecisionScans } from './pages/PdfDecisionScans';
import { LiveClock } from './components/LiveClock';
import { api } from './services/api';
import { useDashboardPoll } from './hooks/usePoll';
import {
  Transaction,
  TransactionStatus,
  Project,
  User,
  AuditLogItem,
  InterestHistoryLog,
  BankAccount,
  BankTransaction,
  BankTransactionType
} from './types';
import {
  calculateInterest,
  formatCurrency,
  isStaffEditingPolicyExempt,
  userCanAccessAdminWorkspaceTab
} from './utils/helpers';

// --- SESSION SETTINGS ---
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes idle => auto logout
const REFRESH_DEBOUNCE_MS = 60 * 1000; // at most refresh once per minute
const REFRESH_WHEN_EXP_WITHIN_MS = 15 * 60 * 1000; // refresh when token expires within 15 minutes
const LS_LAST_ACTIVITY = 'last_activity_ts';
const LS_LAST_REFRESH = 'last_refresh_ts';

function decodeJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson) as { exp?: number };
    if (!payload?.exp) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

const App: React.FC = () => {
  // UI State
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [transactionSearchTerm, setTransactionSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Auth State
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Data State - loaded from API
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);
  const [bankAccount, setBankAccount] = useState<BankAccount>({
    openingBalance: 0,
    currentBalance: 0,
    reconciledBalance: 0
  });
  const [interestRate, setInterestRate] = useState<number>(6.5);
  const [bankInterestRate, setBankInterestRate] = useState<number>(0.5);
  const [interestHistory, setInterestHistory] = useState<InterestHistoryLog[]>([]);
  // Rate change settings
  const [interestRateChangeDate, setInterestRateChangeDate] = useState<string | null>(null);
  const [interestRateBefore, setInterestRateBefore] = useState<number | null>(null);
  const [interestRateAfter, setInterestRateAfter] = useState<number | null>(null);
  const [editingAllowed, setEditingAllowed] = useState(true);

  /** DA đã được tính vào báo cáo (mọi role): không chờ template, không chỉ có GD chờ duyệt import */
  const reportingProjects = useMemo(() => {
    if (!currentUser) return projects;
    return projects.filter((p) => {
      if (p.templateApproved === false) return false;
      const hasStaffPending = transactions.some(
        (t) =>
          String(t.projectId) === String(p.id) &&
          !!(t as { staffImportPending?: boolean }).staffImportPending
      );
      if (hasStaffPending) return false;
      return transactions.some((t) => String(t.projectId) === String(p.id));
    });
  }, [projects, transactions, currentUser]);

  const mayFetchAdminBundles = useCallback((viewer?: User | null) => {
    return !!(viewer && userCanAccessAdminWorkspaceTab(viewer));
  }, []);

  // Load all data from API (chỉ gọi /users + /audit-logs khi có quyền Admin — tránh 403 và log console)
  const loadAllData = useCallback(async (silent: boolean = false, viewerOverride?: User | null) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const viewer = viewerOverride !== undefined ? viewerOverride : currentUser;
      const fetchAdmin = mayFetchAdminBundles(viewer);
      const [
        projectsRes,
        transactionsRes,
        bankBalanceRes,
        bankTxRes,
        usersRes,
        auditRes,
        settingsRes
      ] = await Promise.all([
        api.projects.list().catch(() => ({ data: [] })),
        api.transactions.list({ limit: 10000 }).catch(() => ({ data: [] })),
        api.bank.getBalance().catch(() => ({ data: { openingBalance: 0, currentBalance: 0, reconciledBalance: 0 } })),
        api.bank.listTransactions().catch(() => ({ data: [] })),
        fetchAdmin ? api.users.list().catch(() => ({ data: [] })) : Promise.resolve({ data: [] as User[] }),
        fetchAdmin ? api.audit.list().catch(() => ({ data: [] })) : Promise.resolve({ data: [] as AuditLogItem[] }),
        api.settings.getInterestRate().catch(() => ({
          data: {
            interestRate: 6.5,
            bankInterestRate: 0.5,
            history: [],
            interestRateChangeDate: null,
            interestRateBefore: null,
            interestRateAfter: null,
            editingAllowed: true
          }
        }))
      ]);

      setProjects(projectsRes.data || []);
      setTransactions(transactionsRes.data || []);
      setBankAccount(bankBalanceRes.data || { openingBalance: 0, currentBalance: 0, reconciledBalance: 0 });
      setBankTransactions(bankTxRes.data || []);
      setUsers(usersRes.data || []);
      setAuditLogs(auditRes.data || []);
      setInterestRate(settingsRes.data?.interestRate || 6.5);
      setBankInterestRate(settingsRes.data?.bankInterestRate || 0.5);
      setInterestHistory(settingsRes.data?.interestHistory || []);
      // Load rate change settings
      setInterestRateChangeDate(settingsRes.data?.interestRateChangeDate || null);
      setInterestRateBefore(settingsRes.data?.interestRateBefore || null);
      setInterestRateAfter(settingsRes.data?.interestRateAfter || null);
      setEditingAllowed(settingsRes.data?.editingAllowed !== false);
    } catch (err: any) {
      console.error('Failed to load data:', err);
      setError('Không thể tải dữ liệu. Vui lòng thử lại.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentUser, mayFetchAdminBundles]);

  /** Giữ phiên bản mới nhất để effects không phụ thuộc loadAllData (tránh vòng lặp khi currentUser/loadAllData đổi identity) */
  const loadAllDataRef = useRef(loadAllData);
  loadAllDataRef.current = loadAllData;

  // Check auth token on mount — chạy đúng 1 lần; không được phụ thuộc loadAllData
  useEffect(() => {
    const token = localStorage.getItem('auth_token');

    if (token) {
      api.auth.me()
        .then(async res => {
          if (res.data && res.data.id) {
            setCurrentUser(res.data);
            await loadAllDataRef.current(false, res.data);
          } else {
            handleLogout('Dữ liệu xác thực không hợp lệ (Thiếu ID)');
          }
        })
        .catch((err) => {
          if (err.message === 'Session expired') {
            localStorage.removeItem('auth_token');
          } else {
            handleLogout(`Lỗi kết nối xác thực: ${err.message}`);
          }
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps — chỉ khi mount; loadAllData qua ref
  }, []);

  // Background polling for real-time updates
  useDashboardPoll(() => {
    loadAllDataRef.current(true);
  }, !!currentUser);

  // Sync selected transaction when transactions list updates
  useEffect(() => {
    if (selectedTransaction) {
      const updated = transactions.find(t => t.id === selectedTransaction.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedTransaction)) {
        console.log('🔄 Syncing selected transaction with latest data');
        setSelectedTransaction(updated);
      }
    }
  }, [transactions, selectedTransaction]);

  // Trigger monthly bank interest accrual — 1 lần mỗi user.id, không ép chạy lại khi loadAllData đổi reference
  useEffect(() => {
    if (!currentUser?.id) return;
    api.bank.accrueInterest().then(res => {
      if (res.data?.accruedCount != null && res.data.accruedCount > 0) {
        void loadAllDataRef.current(true);
      }
    }).catch(() => {
      /* bỏ qua khi không phải đầu tháng / không đủ quyền */
    });
  }, [currentUser?.id]);

  // Handle login
  const handleLogin = async (user: User) => {
    setCurrentUser(user);
    await loadAllData(false, user);
  };

  // Handle logout
  const handleLogout = (reason?: string) => {
    if (reason) {
      console.log('[LOGOUT] Triggered by reason:', reason);
    } else {
      console.log('[LOGOUT] Explicit user logout');
    }
    api.auth.logout();
    setCurrentUser(null);
    setActiveTab('dashboard');
    // Clear data
    setTransactions([]);
    setProjects([]);
    setUsers([]);
    setAuditLogs([]);
    setBankTransactions([]);
    setBankAccount({ openingBalance: 0, currentBalance: 0, reconciledBalance: 0 });
  };

  // --- Sliding session + idle logout ---
  useEffect(() => {
    if (!currentUser) return;

    // Initialize activity timestamps on login
    const now = Date.now();
    localStorage.setItem(LS_LAST_ACTIVITY, String(now));
    if (!localStorage.getItem(LS_LAST_REFRESH)) {
      localStorage.setItem(LS_LAST_REFRESH, String(now));
    }

    let refreshInFlight = false;

    const maybeRefreshToken = async () => {
      const token = localStorage.getItem('auth_token');
      if (!token) return;

      const expMs = decodeJwtExpMs(token);
      if (!expMs) return;

      const nowTs = Date.now();
      const lastRefresh = parseInt(localStorage.getItem(LS_LAST_REFRESH) || '0', 10) || 0;
      if (nowTs - lastRefresh < REFRESH_DEBOUNCE_MS) return;

      // Only refresh when token is getting close to expiry
      if (expMs - nowTs > REFRESH_WHEN_EXP_WITHIN_MS) return;

      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        await api.auth.refresh();
        localStorage.setItem(LS_LAST_REFRESH, String(Date.now()));
      } catch (err: any) {
        // If refresh fails, logout (token might be invalid)
        handleLogout(`Phiên đăng nhập không còn hợp lệ: ${err.message || 'refresh failed'}`);
      } finally {
        refreshInFlight = false;
      }
    };

    const recordActivity = () => {
      localStorage.setItem(LS_LAST_ACTIVITY, String(Date.now()));
      // Sliding session: refresh while user is active on dashboard
      void maybeRefreshToken();
    };

    // Activity events (only while logged in)
    const events: Array<keyof WindowEventMap> = [
      'click',
      'keydown',
      'mousemove',
      'scroll',
      'touchstart'
    ];
    events.forEach((evt) => window.addEventListener(evt, recordActivity, { passive: true }));

    // Idle checker
    const idleTimer = window.setInterval(() => {
      const last = parseInt(localStorage.getItem(LS_LAST_ACTIVITY) || '0', 10) || 0;
      const idleMs = Date.now() - last;
      if (idleMs > IDLE_TIMEOUT_MS) {
        handleLogout('Tự động đăng xuất do không thao tác quá 10 phút');
      }
    }, 15 * 1000);

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, recordActivity));
      window.clearInterval(idleTimer);
    };
  }, [currentUser]);

  // Add bank transaction via API
  const handleAddBankTransaction = useCallback(async (type: BankTransactionType, amount: number, note: string, date: string, projectId?: string) => {
    try {
      await api.bank.addTransaction({ type, amount, note, date, projectId });
      // Reload bank data
      const [balanceRes, txRes] = await Promise.all([
        api.bank.getBalance(),
        api.bank.listTransactions()
      ]);
      setBankAccount(balanceRes.data);
      setBankTransactions(txRes.data);
    } catch (err: any) {
      console.error('Add bank transaction failed:', err);
    }
  }, []);

  // Handle status change via API
  const handleStatusChange = async (id: string, newStatus: TransactionStatus, disbursementDate?: string) => {
    try {
      await api.transactions.updateStatus(id, newStatus, currentUser?.name || 'Unknown', disbursementDate);
      const [txRes, balanceRes, bankTxRes] = await Promise.all([
        api.transactions.list({ limit: 10000 }),
        api.bank.getBalance(),
        api.bank.listTransactions()
      ]);
      setTransactions(txRes.data);
      setBankAccount(balanceRes.data);
      setBankTransactions(bankTxRes.data);
      setSelectedTransaction(null);
    } catch (err: any) {
      console.error('Status change failed:', err);
      alert('Lỗi khi cập nhật trạng thái: ' + (err?.message || 'Unknown error'));
    }
  };

  // Handle refund via API
  const handleRefundTransaction = async (id: string, refundedAmount: number) => {
    try {
      await api.transactions.refund(id, refundedAmount, undefined, currentUser?.name || 'Unknown');
      const [txRes, balanceRes, bankTxRes] = await Promise.all([
        api.transactions.list({ limit: 10000 }),
        api.bank.getBalance(),
        api.bank.listTransactions()
      ]);
      setTransactions(txRes.data);
      setBankAccount(balanceRes.data);
      setBankTransactions(bankTxRes.data);
      setSelectedTransaction(null);
    } catch (err: any) {
      console.error('Refund failed:', err);
    }
  };

  // Handle update transaction via API
  const handleUpdateTransaction = async (updatedTransaction: Transaction) => {
    try {
      await api.transactions.update(updatedTransaction.id, updatedTransaction);
      const txRes = await api.transactions.list({ limit: 10000 });
      setTransactions(txRes.data);
    } catch (err: any) {
      console.error('Update transaction failed:', err);
    }
  };

  // Handle import project via API
  // Note: This is called AFTER the API call in Projects.tsx has already succeeded
  // So we just need to refresh the data, not call API again
  const handleImportProject = async (project: Project, txs: Transaction[], importMode?: 'create' | 'merge') => {
    try {
      // API was already called in Projects.tsx, just refresh data
      console.log(`Import ${importMode || 'create'} successful, refreshing data...`);
      await loadAllData();
    } catch (err: any) {
      console.error('Refresh after import failed:', err);
      // Don't set error here as the import already succeeded
    }
  };

  // Render content based on active tab
  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="text-center py-12">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => loadAllData()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Thử lại
          </button>
        </div>
      );
    }

    const readOnlyStaff = !!(
      currentUser &&
      !isStaffEditingPolicyExempt(currentUser.role, currentUser.permissions) &&
      !editingAllowed
    );

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard
          transactions={transactions}
          projects={reportingProjects}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          bankAccount={bankAccount}
          setActiveTab={setActiveTab}
          currentUser={currentUser!}
        />;
      case 'projects':
        return <Projects
          projects={projects}
          transactions={transactions}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          readOnlyStaff={readOnlyStaff}
          currentUser={currentUser}
          onApproveTemplateDone={() => loadAllData(true)}
          onImport={handleImportProject}
          onUpdateProject={async (p) => {
            await api.projects.update(p.id, p);
            const [projectsRes, transactionsRes] = await Promise.all([
              api.projects.list(),
              api.transactions.list({ limit: 10000 })
            ]);
            setProjects(projectsRes.data);
            setTransactions(transactionsRes.data);
          }}
          onViewDetails={(c) => { setTransactionSearchTerm(c); setActiveTab('transactions'); }}
          onDeleteProject={async (id) => {
            try {
              console.log(`[PROJECT_DELETE] Attempting to delete project ID: "${id}"`);
              if (!id) {
                console.error('[PROJECT_DELETE] Aborting - ID is empty!');
                throw new Error('Project ID is required (client-side check)');
              }
              setLoading(true);
              await api.projects.delete(id);
              console.log('[PROJECT_DELETE] Success');
              await loadAllData();
            } catch (err: any) {
              console.error('Delete project failed:', err);
              setError('Lỗi khi xóa dự án: ' + (err.message || 'Unknown error'));
            } finally {
              setLoading(false);
            }
          }}
        />;
      case 'balance':
        return <BankBalance
          transactions={transactions}
          projects={reportingProjects}
          bankAccount={bankAccount}
          bankTransactions={bankTransactions}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          currentUser={currentUser!}
          readOnlyStaff={readOnlyStaff}
          onAddBankTransaction={handleAddBankTransaction}
          onAdjustOpeningBalance={async (b) => {
            await api.bank.adjustOpening(b);
            const res = await api.bank.getBalance();
            setBankAccount(res.data);
          }}
          setAuditLogs={setAuditLogs}
        />;
      case 'transactions':
        return <TransactionList
          transactions={transactions}
          projects={projects}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          currentUser={currentUser!}
          readOnlyStaff={readOnlyStaff}
          onSelect={setSelectedTransaction}
          searchTerm={transactionSearchTerm}
          setSearchTerm={setTransactionSearchTerm}
          onDelete={loadAllData}
        />;
      case 'admin':
        if (!userCanAccessAdminWorkspaceTab(currentUser!)) {
          return (
            <div className="max-w-lg mx-auto py-16 text-center text-slate-600 font-medium">
              Bạn không có quyền truy cập tab Admin. Liên hệ quản trị viên để được cấp quyền «Admin» trong phân quyền tab.
            </div>
          );
        }
        return <Admin
          auditLogs={auditLogs}
          users={users}
          onAddUser={async (u) => {
            await api.users.create(u);
            const res = await api.users.list();
            setUsers(res.data);
          }}
          onUpdateUser={async (u) => {
            await api.users.update(u.id, u);
            const res = await api.users.list();
            setUsers(res.data);
          }}
          onDeleteUser={async (userId) => {
            try {
              await api.users.delete(userId);
              const res = await api.users.list();
              setUsers(res.data);
            } catch (err: any) {
              console.error('Delete user failed:', err);
              alert('Lỗi khi xóa người dùng: ' + (err.message || 'Unknown error'));
            }
          }}
          interestRate={interestRate}
          onUpdateInterestRate={async (rate) => {
            await api.settings.updateInterestRate(rate, currentUser?.name || 'Unknown');
            const res = await api.settings.getInterestRate();
            setInterestRate(res.data.interestRate);
            setInterestHistory(res.data.interestHistory || []);
          }}
          bankInterestRate={bankInterestRate}
          onUpdateBankInterestRate={async (rate) => {
            await api.settings.updateBankInterestRate(rate, currentUser?.name || 'Unknown');
            const res = await api.settings.getInterestRate();
            setBankInterestRate(res.data.bankInterestRate);
          }}
          interestHistory={interestHistory}
          currentUser={currentUser!}
          setAuditLogs={setAuditLogs}
          setInterestHistory={setInterestHistory}
        />;
      case 'interestCalc':
        return <InterestCalculator
          transactions={transactions}
          projects={reportingProjects}
          interestRate={interestRate}
          currentUser={currentUser!}
        />;
      case 'pdf':
        return <PdfDecisionScans currentUser={currentUser!} readOnlyStaff={readOnlyStaff} />;
      default:
        return null;
    }
  };

  // Check for confirm route
  const getConfirmId = (): string | null => {
    const hash = window.location.hash;
    const hashMatch = hash.match(/#\/confirm\/(.+)/);
    if (hashMatch) return hashMatch[1];

    const path = window.location.pathname;
    const pathMatch = path.match(/\/confirm\/(.+)/);
    if (pathMatch) return pathMatch[1];

    return null;
  };

  // Show loading screen while verifying auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-blue-600 border-t-transparent"></div>
          <p className="text-slate-500 font-medium animate-pulse text-sm">Đang tải dữ liệu...</p>
        </div>
      </div>
    );
  }

  const confirmTransactionId = getConfirmId();

  // Show confirm page - NOW REQUIRES LOGIN
  if (confirmTransactionId) {
    // Always render ConfirmPage - it will handle authentication itself
    // This allows ConfirmPage to check localStorage in new tabs from QR scans
    // ConfirmPage has its own logic to check token and redirect to login if needed
    return <ConfirmPage transactionId={confirmTransactionId} currentUser={currentUser || null} />;
  }

  // Show login page if not logged in
  if (!currentUser) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <HashRouter>
      <div className="min-h-screen text-slate-800 font-sans selection:bg-blue-100 selection:text-blue-900">
        <div>
          <Sidebar
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            currentUser={currentUser}
            onLogout={handleLogout}
            editingAllowed={editingAllowed}
            onEditingAllowedChange={async (allowed) => {
              const res = await api.settings.updateEditingAllowed(allowed);
              setEditingAllowed((res as { data?: { editingAllowed?: boolean } }).data?.editingAllowed !== false);
            }}
          />
        </div>
        <main className="ml-64 p-8 min-h-screen relative bg-[#f8fafc]">
          {renderContent()}
        </main>
        {/* Live Clock - Bottom Right (only show when logged in) */}
        {currentUser && <LiveClock />}
        {selectedTransaction && (
          <TransactionModal
            transaction={selectedTransaction}
            project={projects.find(p => p.id === selectedTransaction.projectId || (p as any)._id === selectedTransaction.projectId)}
            interestRate={interestRate}
            interestRateChangeDate={interestRateChangeDate}
            interestRateBefore={interestRateBefore}
            interestRateAfter={interestRateAfter}
            onClose={() => setSelectedTransaction(null)}
            onStatusChange={handleStatusChange}
            onRefund={handleRefundTransaction}
            onUpdateTransaction={handleUpdateTransaction}
            currentUser={currentUser}
            setAuditLogs={setAuditLogs}
            handleAddBankTransaction={handleAddBankTransaction}
            readOnlyStaff={!!(
              currentUser &&
              !isStaffEditingPolicyExempt(currentUser.role, currentUser.permissions) &&
              !editingAllowed
            )}
          />
        )}
      </div>
    </HashRouter>
  );
};

export default App;
