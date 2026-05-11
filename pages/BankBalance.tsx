
import React, { useState, useMemo, useEffect } from 'react';
import { GlassCard } from '../components/GlassCard';
import {
  BankTransaction,
  BankTransactionType,
  BankAccount,
  User,
  Transaction,
  Project,
  TransactionStatus,
  AuditLogItem
} from '../types';
import {
  formatCurrency,
  formatDate,
  calculateInterest,
  calculateInterestWithRateChange,
  formatNumberWithComma,
  parseNumberFromComma,
  roundTo2,
  exportBalanceProjectDetailToExcel,
  toVNTime,
  getVNStartOfDay,
  getVNEndOfDay
} from '../utils/helpers';
import {
  Wallet, History, X, Table2, ChevronLeft, ChevronRight, Download, Search
} from 'lucide-react';

interface BankBalanceProps {
  transactions: Transaction[];
  projects: Project[];
  bankAccount: BankAccount;
  bankTransactions: BankTransaction[];
  interestRate: number;
  interestRateChangeDate?: string | null;
  interestRateBefore?: number | null;
  interestRateAfter?: number | null;
  currentUser: User;
  onAddBankTransaction: (type: BankTransactionType, amount: number, note: string, date: string) => void;
  onAdjustOpeningBalance: (amount: number) => void;
  setAuditLogs: React.Dispatch<React.SetStateAction<AuditLogItem[]>>;
  readOnlyStaff?: boolean;
}

const DETAIL_PROJECTS_PAGE_SIZE = 10;

function transactionProjectIdString(t: Transaction): string | null {
  const raw = t.projectId;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') {
    const o = raw as { _id?: unknown; id?: unknown };
    const id = o._id ?? o.id;
    return id !== undefined && id !== null ? String(id) : null;
  }
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function resolveProject(projects: Project[], pidStr: string): Project | undefined {
  return projects.find((p) => String(p.id) === pidStr || String((p as { _id?: string })._id) === pidStr);
}

/** Giao dịch có ít nhất một mốc ngày liên quan nằm trong [start, end] (VN). Giải ngân: theo ngày GN; còn lại: quyết định / lãi / lịch sử rút. */
function transactionInBalanceDetailDateRange(t: Transaction, start: Date, end: Date): boolean {
  const inR = (d: Date) => !isNaN(d.getTime()) && d >= start && d <= end;
  if (t.status === TransactionStatus.DISBURSED) {
    if (t.disbursementDate) return inR(toVNTime(t.disbursementDate));
  }
  const cand: Date[] = [];
  if (t.household?.decisionDate) cand.push(toVNTime(t.household.decisionDate));
  if (t.effectiveInterestDate) cand.push(toVNTime(t.effectiveInterestDate));
  for (const log of t.history ?? []) {
    const a = String(log.action || '');
    if (log.timestamp && (a.includes('Rút') || a.includes('Giải ngân'))) {
      cand.push(toVNTime(log.timestamp));
    }
  }
  return cand.some(inR);
}

/** Ngày rút một phần gần nhất (lịch sử); fallback effectiveInterestDate nếu có withdrawnAmount. */
function getLatestPartialWithdrawTimestamp(t: Transaction): string | null {
  const hist = t.history ?? [];
  let best: string | null = null;
  for (const log of hist) {
    const a = String(log.action || '');
    if (a.includes('một phần') && log.timestamp) {
      const ts = log.timestamp;
      if (!best || new Date(ts) > new Date(best)) best = ts;
    }
  }
  if (best) return best;
  const w = (t as unknown as { withdrawnAmount?: number }).withdrawnAmount;
  if (w && t.effectiveInterestDate) return t.effectiveInterestDate;
  return null;
}

type BalanceDetailDateRange = { start: Date; end: Date };

/** Dòng NH có gắn `projectId` (chuỗi không rỗng hoặc object id). Dùng khi phân biệt giao dịch gắn dự án và dòng thuần “quỹ / phí”. */
function bankTransactionHasProject(bt: BankTransaction): boolean {
  const raw = bt.projectId;
  if (raw == null || raw === '') return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return typeof raw === 'object';
}

/** Giải ngân hoàn toàn + rút một phần (khớp tab Quản lý dự án) — có đổi lãi suất */
function sumDisbursedForProjectTransactions(
  project: Project | undefined,
  projectTrans: Transaction[],
  interestRate: number,
  interestRateChangeDate?: string | null,
  interestRateBefore?: number | null,
  interestRateAfter?: number | null,
  detailRange?: BalanceDetailDateRange | null
): number {
  const hasRateChange = !!(interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null);
  const interestTo = (principal: number, baseDate: string | undefined, end: Date) =>
    hasRateChange
      ? calculateInterestWithRateChange(
          principal,
          baseDate,
          end,
          interestRateChangeDate!,
          interestRateBefore!,
          interestRateAfter!
        ).totalInterest
      : calculateInterest(principal, interestRate, baseDate, end);

  const interestStartFallback = project?.interestStartDate || (project as { startDate?: string })?.startDate;

  const disbursementInRange = (tx: Transaction) => {
    if (!detailRange || !tx.disbursementDate) return true;
    const d = toVNTime(tx.disbursementDate);
    return d >= detailRange.start && d <= detailRange.end;
  };

  const partialWithdrawInRange = (tx: Transaction) => {
    if (!detailRange) return true;
    const ts = getLatestPartialWithdrawTimestamp(tx);
    if (!ts) return false;
    const d = toVNTime(ts);
    return d >= detailRange.start && d <= detailRange.end;
  };

  const disbursedFull = projectTrans
    .filter((tx) => tx.status === TransactionStatus.DISBURSED)
    .filter((tx) => disbursementInRange(tx))
    .reduce((acc, t) => {
      const supplementary = t.supplementaryAmount || 0;
      const baseDate = t.effectiveInterestDate || interestStartFallback;
      const interest = t.disbursementDate
        ? interestTo(t.compensation.totalApproved, baseDate, new Date(t.disbursementDate))
        : 0;
      const computedTotal = roundTo2(t.compensation.totalApproved + interest + supplementary);
      const storedTotal = Number((t as unknown as { disbursedTotal?: number }).disbursedTotal);
      const totalToUse =
        isFinite(storedTotal) &&
        storedTotal > 0 &&
        Math.abs(roundTo2(storedTotal) - computedTotal) < 0.01
          ? roundTo2(storedTotal)
          : computedTotal;
      return acc + totalToUse;
    }, 0);

  const disbursedPartial = projectTrans
    .filter((tx) => tx.status !== TransactionStatus.DISBURSED && (tx as unknown as { withdrawnAmount?: number }).withdrawnAmount)
    .filter((tx) => partialWithdrawInRange(tx))
    .reduce((acc, t) => acc + (((t as unknown as { withdrawnAmount?: number }).withdrawnAmount) || 0), 0);

  return roundTo2(disbursedFull + disbursedPartial);
}

/** Lãi tạm tính trên các hồ sơ chưa giải ngân (không tính vào phần đã GN) */
function sumInterestUndisbursedForProject(
  project: Project | undefined,
  projectTrans: Transaction[],
  interestRate: number,
  interestRateChangeDate?: string | null,
  interestRateBefore?: number | null,
  interestRateAfter?: number | null,
  interestAsOf?: Date
): number {
  const hasRateChange = !!(interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null);
  const endDate = interestAsOf ?? new Date();
  let sum = 0;
  for (const t of projectTrans) {
    if (t.status === TransactionStatus.DISBURSED) continue;
    const baseDate = t.effectiveInterestDate || project?.interestStartDate;
    const principalBase =
      (t as unknown as { principalForInterest?: number }).principalForInterest ?? t.compensation.totalApproved;
    let tInterest = 0;
    if (hasRateChange) {
      const interestResult = calculateInterestWithRateChange(
        principalBase,
        baseDate,
        endDate,
        interestRateChangeDate!,
        interestRateBefore!,
        interestRateAfter!
      );
      tInterest = interestResult.totalInterest;
    } else {
      tInterest = calculateInterest(principalBase, interestRate, baseDate, endDate);
    }
    sum += tInterest;
  }
  return roundTo2(sum);
}

/** Phần lãi trong các phiếu Đã giải ngân (tách từ disbursedTotal / tính theo ngày GN — khớp pendingData). */
function sumLockedInterestForProject(
  project: Project | undefined,
  projectTrans: Transaction[],
  interestRate: number,
  interestRateChangeDate?: string | null,
  interestRateBefore?: number | null,
  interestRateAfter?: number | null
): number {
  const hasRateChange = !!(interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null);
  const interestStartFallback = project?.interestStartDate || (project as { startDate?: string })?.startDate;
  let locked = 0;
  for (const t of projectTrans) {
    if (t.status !== TransactionStatus.DISBURSED || !t.disbursementDate) continue;
    const baseDate = t.effectiveInterestDate || interestStartFallback;
    const supplementary = t.supplementaryAmount || 0;
    const storedTotal = Number((t as unknown as { disbursedTotal?: number }).disbursedTotal);
    let calculatedInterest = 0;
    if (hasRateChange) {
      calculatedInterest = calculateInterestWithRateChange(
        t.compensation.totalApproved,
        baseDate,
        new Date(t.disbursementDate),
        interestRateChangeDate!,
        interestRateBefore!,
        interestRateAfter!
      ).totalInterest;
    } else {
      calculatedInterest = calculateInterest(
        t.compensation.totalApproved,
        interestRate,
        baseDate,
        new Date(t.disbursementDate)
      );
    }
    const computedTotal = roundTo2(t.compensation.totalApproved + calculatedInterest + supplementary);
    if (isFinite(storedTotal) && storedTotal > 0 && Math.abs(roundTo2(storedTotal) - computedTotal) < 0.01) {
      locked += roundTo2(storedTotal) - t.compensation.totalApproved - supplementary;
    } else {
      locked += calculatedInterest;
    }
  }
  return roundTo2(locked);
}

export const BankBalance: React.FC<BankBalanceProps> = ({
  transactions,
  projects,
  bankAccount,
  bankTransactions,
  interestRate,
  interestRateChangeDate,
  interestRateBefore,
  interestRateAfter,
  onAddBankTransaction,
  currentUser,
  setAuditLogs,
  readOnlyStaff = false
}) => {
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [isBalanceDetailModalOpen, setIsBalanceDetailModalOpen] = useState(false);
  const [detailModalPage, setDetailModalPage] = useState(1);
  const [detailDateFrom, setDetailDateFrom] = useState('');
  const [detailDateTo, setDetailDateTo] = useState('');
  const [detailProjectSearch, setDetailProjectSearch] = useState('');

  const [txType, setTxType] = useState<BankTransactionType>(BankTransactionType.DEPOSIT);
  const [txAmount, setTxAmount] = useState('');
  const [txNote, setTxNote] = useState('');
  const [txDate, setTxDate] = useState(new Date().toISOString().split('T')[0]);

  // --- TÍNH TỔNG GỐC, LÃI TẠM TÍNH & TIỀN BỔ SUNG ---
  // Tính từ các giao dịch CHƯA giải ngân (PENDING + HOLD) để khớp với "Tiền chưa GN"
  // Khi giải ngân, các giá trị này sẽ tự động giảm đi
  const pendingData = useMemo(() => {
    if (transactions.length === 0) return { principal: 0, interest: 0, supplementary: 0, locked: 0 };

    let principal = 0; // Tổng gốc của các giao dịch chưa giải ngân
    let tempInterest = 0; // Lãi tạm tính (chưa giải ngân) - giữ 2 chữ số thập phân
    let lockedInterest = 0; // Lãi đã chốt (đã giải ngân) - giữ 2 chữ số thập phân
    let supplementaryAmount = 0; // Tổng tiền bổ sung từ các giao dịch chưa giải ngân

    // Check if rate change is configured
    const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;

    transactions.forEach(t => {
      const project = projects.find(p => p.id === t.projectId);
      const baseDate = t.effectiveInterestDate || project?.interestStartDate;
      // Nếu đã rút 1 phần, dùng principalForInterest làm gốc còn lại để tính lãi tạm tính
      const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;

      if (t.status === TransactionStatus.DISBURSED && t.disbursementDate) {
        // Lãi đã chốt:
        // - Nếu disbursedTotal khớp (không bị làm tròn mất phần lẻ): tách lãi từ disbursedTotal để đúng theo số đã chốt
        // - Nếu disbursedTotal có sai lệch (thường do dữ liệu cũ làm tròn): fallback sang lãi tính lại theo ngày GN
        const supplementary = t.supplementaryAmount || 0;
        const storedTotal = Number((t as any).disbursedTotal);

        // Calculate interest with rate change support (used both as primary fallback and for consistency check)
        let calculatedInterest = 0;
        if (hasRateChange) {
          const interestResult = calculateInterestWithRateChange(
            t.compensation.totalApproved,
            baseDate,
            new Date(t.disbursementDate),
            interestRateChangeDate,
            interestRateBefore,
            interestRateAfter
          );
          calculatedInterest = interestResult.totalInterest;
        } else {
          calculatedInterest = calculateInterest(t.compensation.totalApproved, interestRate, baseDate, new Date(t.disbursementDate));
        }

        const computedTotal = roundTo2(t.compensation.totalApproved + calculatedInterest + supplementary);
        if (isFinite(storedTotal) && storedTotal > 0 && Math.abs(roundTo2(storedTotal) - computedTotal) < 0.01) {
          const extractedInterest = roundTo2(storedTotal) - t.compensation.totalApproved - supplementary;
          lockedInterest += extractedInterest;
        } else {
          lockedInterest += calculatedInterest;
        }
      } else if (t.status !== TransactionStatus.DISBURSED) {
        // Tổng gốc của các giao dịch chưa giải ngân (chỉ phần còn lại sau khi rút)
        principal += principalBase;
        // Lãi tạm tính (chỉ từ các giao dịch chưa giải ngân) - giữ 2 chữ số thập phân, chỉ làm tròn ở kết quả tổng
        // Calculate interest with rate change support
        let tInterest = 0;
        if (hasRateChange) {
          const interestResult = calculateInterestWithRateChange(
            principalBase,
            baseDate,
            new Date(),
            interestRateChangeDate,
            interestRateBefore,
            interestRateAfter
          );
          tInterest = interestResult.totalInterest;
        } else {
          tInterest = calculateInterest(principalBase, interestRate, baseDate, new Date());
        }
        tempInterest += tInterest;
        // Tiền bổ sung từ các giao dịch chưa giải ngân
        supplementaryAmount += t.supplementaryAmount || 0;
      }
    });

    return {
      principal, // Tổng gốc chưa giải ngân
      interest: tempInterest, // Lãi tạm tính (giữ 2 chữ số thập phân, sẽ làm tròn khi hiển thị)
      locked: lockedInterest, // Lãi đã chốt (giữ 2 chữ số thập phân, sẽ làm tròn khi hiển thị)
      supplementary: supplementaryAmount // Tổng tiền bổ sung chưa giải ngân
    };
  }, [transactions, projects, interestRate, interestRateChangeDate, interestRateBefore, interestRateAfter, bankAccount.currentBalance]);

  const { detailDateRange, detailDateRangeInvalid } = useMemo(() => {
    const f = detailDateFrom.trim();
    const t = detailDateTo.trim();
    if (!f || !t) {
      return { detailDateRange: null as BalanceDetailDateRange | null, detailDateRangeInvalid: false };
    }
    const start = getVNStartOfDay(`${f}T00:00:00+07:00`);
    const end = getVNEndOfDay(`${t}T23:59:59+07:00`);
    if (start > end) {
      return { detailDateRange: null as BalanceDetailDateRange | null, detailDateRangeInvalid: true };
    }
    return { detailDateRange: { start, end } as BalanceDetailDateRange, detailDateRangeInvalid: false };
  }, [detailDateFrom, detailDateTo]);

  /** Chi tiết dự án: Còn lại = Phê duyệt − Đã GN + Lãi tạm + Lãi đã chốt */
  const balanceDetailByProject = useMemo(() => {
    const txsByPid = new Map<string, Transaction[]>();
    for (const t of transactions) {
      const pid = transactionProjectIdString(t);
      if (!pid || !resolveProject(projects, pid)) continue;
      if (!txsByPid.has(pid)) txsByPid.set(pid, []);
      txsByPid.get(pid)!.push(t);
    }

    const range = detailDateRange;
    const interestAsOf = range
      ? (() => {
          const cap = new Date();
          return range.end > cap ? cap : range.end;
        })()
      : undefined;

    const rows = [...txsByPid.entries()]
      .map(([projectId, projectTransAll]) => {
        const projectTrans = range
          ? projectTransAll.filter((t) => transactionInBalanceDetailDateRange(t, range.start, range.end))
          : projectTransAll;

        if (range && projectTrans.length === 0) return null;

        const project = resolveProject(projects, projectId);
        const code = project?.code ?? projectId.slice(-8);
        const name = project?.name ?? '—';
        const householdCount = projectTrans.length;
        const householdNotReceived = projectTrans.filter((t) => t.status !== TransactionStatus.DISBURSED).length;

        const sumApprovedFromTx = projectTrans.reduce((s, t) => s + (t.compensation?.totalApproved ?? 0), 0);
        const totalPheDuyet =
          !range && project && project.totalBudget > 0
            ? roundTo2(project.totalBudget)
            : roundTo2(sumApprovedFromTx);

        const disbursedTotal = sumDisbursedForProjectTransactions(
          project,
          projectTrans,
          interestRate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter,
          range
        );
        const interest = sumInterestUndisbursedForProject(
          project,
          projectTrans,
          interestRate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter,
          interestAsOf
        );
        const interestLocked = sumLockedInterestForProject(
          project,
          projectTrans,
          interestRate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter
        );
        const remaining = roundTo2(totalPheDuyet - disbursedTotal + interest + interestLocked);

        return {
          projectId,
          code,
          name,
          householdCount,
          householdNotReceived,
          totalPheDuyet,
          disbursedTotal,
          interest,
          interestLocked,
          remaining
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return rows
      .sort((a, b) =>
        Number.isFinite(Number(a.code)) && Number.isFinite(Number(b.code))
          ? Number(a.code) - Number(b.code)
          : a.code.localeCompare(b.code)
      )
      .filter(
        (r) =>
          r.householdCount > 0 &&
          (Math.abs(r.remaining) >= 0.5 ||
            r.householdNotReceived > 0 ||
            Math.abs(r.disbursedTotal) >= 0.5 ||
            Math.abs(r.interest) >= 0.005 ||
            Math.abs(r.interestLocked) >= 0.005)
      );
  }, [
    transactions,
    projects,
    interestRate,
    interestRateChangeDate,
    interestRateBefore,
    interestRateAfter,
    detailDateRange
  ]);

  const balanceDetailVisible = useMemo(() => {
    const q = detailProjectSearch.trim().toLowerCase();
    if (!q) return balanceDetailByProject;
    return balanceDetailByProject.filter(
      (r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
    );
  }, [balanceDetailByProject, detailProjectSearch]);

  const detailTotals = useMemo(() => {
    const households = balanceDetailVisible.reduce((acc, r) => acc + r.householdCount, 0);
    const householdsNotReceived = balanceDetailVisible.reduce((acc, r) => acc + r.householdNotReceived, 0);
    const totalPheDuyetSum = balanceDetailVisible.reduce((acc, r) => acc + r.totalPheDuyet, 0);
    const disbursedSum = balanceDetailVisible.reduce((acc, r) => acc + r.disbursedTotal, 0);
    const interestSum = balanceDetailVisible.reduce((acc, r) => acc + r.interest, 0);
    const interestLockedSum = balanceDetailVisible.reduce((acc, r) => acc + r.interestLocked, 0);
    const remainingSum = balanceDetailVisible.reduce((acc, r) => acc + r.remaining, 0);
    return {
      households,
      householdsNotReceived,
      totalPheDuyetSum: roundTo2(totalPheDuyetSum),
      disbursedSum: roundTo2(disbursedSum),
      interestSum: roundTo2(interestSum),
      interestLockedSum: roundTo2(interestLockedSum),
      remainingSum: roundTo2(remainingSum)
    };
  }, [balanceDetailVisible]);

  const detailTotalPages = Math.max(1, Math.ceil(balanceDetailVisible.length / DETAIL_PROJECTS_PAGE_SIZE));

  useEffect(() => {
    if (!isBalanceDetailModalOpen) return;
    const maxPage = Math.max(1, Math.ceil(balanceDetailVisible.length / DETAIL_PROJECTS_PAGE_SIZE));
    setDetailModalPage((p) => Math.min(Math.max(1, p), maxPage));
  }, [isBalanceDetailModalOpen, balanceDetailVisible.length]);

  useEffect(() => {
    setDetailModalPage(1);
  }, [detailDateFrom, detailDateTo, detailProjectSearch]);

  const handleTxSubmit = () => {
    if (readOnlyStaff) {
      alert('Không thể ghi giao dịch khi hệ thống đang khóa chỉnh sửa.');
      return;
    }
    const amountNum = parseNumberFromComma(txAmount);
    if (isNaN(amountNum) || amountNum <= 0) return alert('Số tiền không hợp lệ');
    const finalAmount = txType === BankTransactionType.WITHDRAW ? -amountNum : amountNum;
    const now = new Date();

    // Lưu audit log
    setAuditLogs(prev => [...prev, {
      id: `audit-${Date.now()}`,
      timestamp: now.toISOString(),
      actor: currentUser.name,
      role: currentUser.role,
      action: txType === BankTransactionType.DEPOSIT ? 'Nạp tiền' : 'Rút tiền',
      target: 'Giao dịch dòng tiền',
      details: `${txType === BankTransactionType.DEPOSIT ? 'Nạp' : 'Rút'} ${formatCurrency(Math.abs(finalAmount))}${txNote ? ` - ${txNote}` : ''}`
    }]);

    onAddBankTransaction(txType, finalAmount, txNote, txDate);
    setIsTxModalOpen(false);
    setTxAmount(''); setTxNote('');
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Cho phép xóa hết hoặc nhập số với dấu phẩy
    if (value === '') {
      setTxAmount('');
      return;
    }
    // Loại bỏ tất cả ký tự không phải số và dấu phẩy
    const cleaned = value.replace(/[^\d,]/g, '');
    // Format với dấu phẩy
    const formatted = formatNumberWithComma(cleaned);
    setTxAmount(formatted);
  };

  const detailPageOffset = (detailModalPage - 1) * DETAIL_PROJECTS_PAGE_SIZE;
  const balanceDetailPaged = balanceDetailVisible.slice(
    detailPageOffset,
    detailPageOffset + DETAIL_PROJECTS_PAGE_SIZE
  );

  return (
    <div className="space-y-6 animate-fade-in pb-12">
      <div className="flex flex-wrap justify-between items-end gap-3 pb-2">
        <div>
          <h2 className="text-2xl font-medium text-black tracking-tight">Số dư tài khoản</h2>
          <p className="text-sm font-medium text-slate-500 mt-1">Đối soát & Theo dõi dòng tiền thực tế</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDetailModalPage(1);
            setDetailProjectSearch('');
            setIsBalanceDetailModalOpen(true);
          }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-xs font-black text-slate-800 uppercase tracking-wide shadow-sm hover:bg-slate-50 hover:border-slate-400 transition-colors"
        >
          <Table2 size={18} className="text-blue-600" strokeWidth={2} />
          Chi tiết
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlassCard className="relative overflow-hidden border-blue-400 bg-blue-50/40">
          <div className="absolute -right-4 -top-4 text-blue-100 opacity-50">
            <Wallet size={120} strokeWidth={0.5} />
          </div>
          <h3 className="text-[11px] font-bold text-blue-700 uppercase tracking-widest mb-1">Số dư hiện tại</h3>
          <p className="text-2xl font-bold text-slate-900 tracking-tight">
            {formatCurrency(roundTo2(pendingData.principal + pendingData.interest + pendingData.supplementary))}
          </p>
          <p className="text-[10px] font-medium text-blue-600 mt-2">Bằng tiền chưa GN (gốc + lãi + bổ sung của các giao dịch chưa giải ngân)</p>
        </GlassCard>


        <GlassCard className="relative overflow-hidden border-emerald-300 bg-emerald-50/30">
          <h3 className="text-[11px] font-bold text-emerald-700 uppercase tracking-widest mb-1">Lãi tạm tính</h3>
          <p className="text-2xl font-bold text-emerald-600 tracking-tight">
            {formatCurrency(roundTo2(pendingData.interest))}
          </p>
          {pendingData.locked > 0 && (
            <p className="text-[10px] font-medium text-slate-500 mt-1">
              Đã chốt: {formatCurrency(roundTo2(pendingData.locked))}
            </p>
          )}
        </GlassCard>
      </div>

      <div className="flex flex-col">
        <GlassCard className="p-0 overflow-hidden border-slate-200 flex flex-col h-[650px]">
          <div className="p-5 border-b border-slate-200 bg-white/50 backdrop-blur-md flex justify-between items-center">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
              <History size={16} /> Lịch sử giao dịch dòng tiền
            </h3>
            <button
              type="button"
              onClick={() => setIsTxModalOpen(true)}
              disabled={readOnlyStaff}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Giao dịch mới
            </button>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="text-[10px] text-slate-500 font-bold uppercase sticky top-0 bg-slate-50/90 backdrop-blur-sm z-10 border-b border-slate-200">
                <tr>
                  <th className="p-4">Ngày giao dịch</th>
                  <th className="p-4 min-w-[150px]">Loại</th>
                  <th className="p-4 text-right">Số tiền</th>
                  <th className="p-4 text-right">Số dư thực tế</th>
                  <th className="p-4">Nội dung chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bankTransactions.map((tx) => (
                  <tr key={tx.id} className={`hover:bg-slate-50 transition-colors ${tx.note.includes('Tự động') ? 'bg-blue-50/40 border-l-4 border-blue-500' : ''}`}>
                    <td className="p-4 text-xs font-bold text-slate-800">
                      {tx.note.includes('Tự động') ? '01/01/2026' : formatDate(tx.date)}
                    </td>
                    <td className="p-4 min-w-[150px]">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${tx.type === BankTransactionType.DEPOSIT ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                        {tx.type === BankTransactionType.DEPOSIT ? 'NẠP TIỀN' : 'RÚT TIỀN'}
                      </span>
                    </td>
                    <td className={`p-4 text-right font-bold text-sm ${tx.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {tx.amount >= 0 ? '+' : ''}{formatCurrency(tx.amount)}
                    </td>
                    <td className="p-4 text-right font-bold text-slate-900 text-sm">{formatCurrency(tx.runningBalance)}</td>
                    <td className="p-4 text-xs text-slate-600 font-medium italic">{tx.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      </div>

      {isBalanceDetailModalOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/45 backdrop-blur-sm p-2 sm:p-3 animate-in fade-in duration-200"
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setIsBalanceDetailModalOpen(false)}
        >
          <GlassCard className="w-[min(1720px,calc(100vw-1rem))] max-h-[94vh] flex flex-col bg-white shadow-2xl border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-slate-200 bg-slate-50/80 shrink-0">
              <h3 className="text-base font-black text-slate-900 tracking-tight">Chi tiết dự án</h3>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={balanceDetailVisible.length === 0}
                  onClick={() => {
                    exportBalanceProjectDetailToExcel(
                      balanceDetailVisible.map(
                        ({
                          code,
                          name,
                          householdCount,
                          householdNotReceived,
                          totalPheDuyet,
                          disbursedTotal,
                          interest,
                          interestLocked,
                          remaining
                        }) => ({
                          code,
                          name,
                          householdCount,
                          householdNotReceived,
                          totalPheDuyet,
                          disbursedTotal,
                          interest,
                          interestLocked,
                          remaining
                        })
                      ),
                      detailTotals
                    );
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs font-bold hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Tải toàn bộ danh sách (Excel)"
                >
                  <Download size={18} />
                  Excel
                </button>
                <button
                  type="button"
                  onClick={() => setIsBalanceDetailModalOpen(false)}
                  className="p-2 rounded-lg border border-slate-200 hover:bg-white text-slate-600"
                  aria-label="Đóng"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 px-4 sm:px-5 py-3 border-b border-slate-200 bg-slate-50/60 shrink-0">
              <div className="flex flex-col gap-1">
                <label htmlFor="balance-detail-from" className="text-[10px] font-black text-slate-500 uppercase tracking-wide">
                  Từ ngày
                </label>
                <input
                  id="balance-detail-from"
                  type="date"
                  value={detailDateFrom}
                  onChange={(e) => setDetailDateFrom(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="balance-detail-to" className="text-[10px] font-black text-slate-500 uppercase tracking-wide">
                  Đến ngày
                </label>
                <input
                  id="balance-detail-to"
                  type="date"
                  value={detailDateTo}
                  onChange={(e) => setDetailDateTo(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex flex-col gap-1 flex-1 min-w-[200px] max-w-md">
                <label htmlFor="balance-detail-search" className="text-[10px] font-black text-slate-500 uppercase tracking-wide">
                  Tìm mã / tên dự án
                </label>
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="balance-detail-search"
                    type="text"
                    value={detailProjectSearch}
                    onChange={(e) => setDetailProjectSearch(e.target.value)}
                    placeholder="Nhập mã hoặc tên..."
                    className="w-full rounded-lg border border-slate-300 bg-white pl-8 pr-2 py-2 text-xs font-semibold text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
              {(detailDateFrom || detailDateTo || detailProjectSearch.trim()) && (
                <button
                  type="button"
                  onClick={() => {
                    setDetailDateFrom('');
                    setDetailDateTo('');
                    setDetailProjectSearch('');
                  }}
                  className="mb-0.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-bold text-slate-700 hover:bg-slate-100"
                >
                  Xóa lọc
                </button>
              )}
              {detailDateRange && (
                <p className="mb-0.5 text-[11px] font-medium text-slate-600 max-w-xl">
                  Chỉ tính các hồ sơ có mốc ngày (quyết định / lãi / giải ngân / rút) trong khoảng đã chọn. Lãi chưa giải ngân tính đến hết ngày kết thúc lọc
                  (nếu sau hôm nay thì dùng mốc hôm nay).
                </p>
              )}
              {detailDateRangeInvalid && (
                <p className="mb-0.5 text-[11px] font-bold text-rose-600">
                  «Từ ngày» không được sau «Đến ngày». Đang hiển thị toàn bộ dữ liệu (bỏ qua lọc).
                </p>
              )}
            </div>

            <div className="overflow-y-auto overflow-x-hidden flex-1 min-h-0 p-3 sm:p-4">
              <table className="w-full text-[11px] border-collapse table-fixed">
                <colgroup>
                  <col style={{ width: '4%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '11%' }} />
                </colgroup>
                <thead>
                  <tr className="bg-slate-100 text-[10px] font-black text-slate-700 uppercase border-b border-slate-300">
                    <th className="border border-slate-300 px-1.5 py-2 text-center">STT</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-left">Mã dự án</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-left">Tên dự án</th>
                    <th className="border border-slate-300 px-1 py-2 text-center leading-tight">Tổng hộ dân</th>
                    <th className="border border-slate-300 px-1 py-2 text-center leading-tight">Hộ chưa nhận</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-right leading-tight">Tổng phê duyệt</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-right leading-tight">Đã giải ngân</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-right">Lãi</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-right leading-tight">Lãi đã chốt</th>
                    <th className="border border-slate-300 px-1.5 py-2 text-right">Còn lại</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-slate-50 font-black border-b border-slate-300">
                    <td className="border border-slate-300 px-1.5 py-2 text-center text-slate-500">—</td>
                    <td className="border border-slate-300 px-1.5 py-2"></td>
                    <td className="border border-slate-300 px-1.5 py-2 text-slate-900 min-w-0">TỔNG CỘNG</td>
                    <td className="border border-slate-300 px-1 py-2 text-center">{detailTotals.households}</td>
                    <td className="border border-slate-300 px-1 py-2 text-center">{detailTotals.householdsNotReceived}</td>
                    <td className="border border-slate-300 px-1.5 py-2 text-right tabular-nums">{formatCurrency(detailTotals.totalPheDuyetSum)}</td>
                    <td className="border border-slate-300 px-1.5 py-2 text-right tabular-nums">{formatCurrency(detailTotals.disbursedSum)}</td>
                    <td className="border border-slate-300 px-1.5 py-2 text-right tabular-nums">{formatCurrency(detailTotals.interestSum)}</td>
                    <td className="border border-slate-300 px-1.5 py-2 text-right tabular-nums">{formatCurrency(detailTotals.interestLockedSum)}</td>
                    <td className="border border-slate-300 px-1.5 py-2 text-right bg-amber-200 text-slate-900 tabular-nums">
                      {formatCurrency(detailTotals.remainingSum)}
                    </td>
                  </tr>

                  {balanceDetailPaged.map((row, idx) => {
                    const stt = detailPageOffset + idx + 1;
                    return (
                      <tr key={`${row.projectId}-${detailPageOffset + idx}`} className="hover:bg-blue-50/30 border-b border-slate-200">
                        <td className="border border-slate-300 px-1.5 py-1.5 text-center font-bold text-slate-700">{stt}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 font-mono font-bold align-top">{row.code}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 font-semibold text-slate-900 min-w-0 break-words align-top">{row.name}</td>
                        <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-slate-800">{row.householdCount}</td>
                        <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-amber-900">{row.householdNotReceived}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 text-right font-bold text-slate-800 tabular-nums">{formatCurrency(row.totalPheDuyet)}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 text-right font-bold tabular-nums">{formatCurrency(row.disbursedTotal)}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 text-right font-bold tabular-nums">{formatCurrency(row.interest)}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 text-right font-bold text-sky-900 tabular-nums">{formatCurrency(row.interestLocked)}</td>
                        <td className="border border-slate-300 px-1.5 py-1.5 text-right font-black text-emerald-800 tabular-nums">{formatCurrency(row.remaining)}</td>
                      </tr>
                    );
                  })}

                  {balanceDetailByProject.length === 0 && (
                    <tr>
                      <td colSpan={10} className="border border-slate-300 px-4 py-8 text-center text-slate-500 font-medium">
                        {detailDateRange
                          ? 'Không có hồ sơ nào có mốc ngày trong khoảng đã chọn (hoặc không đủ điều kiện hiển thị dòng).'
                          : 'Không có khoản chưa giải ngân trên các dự án hiện tại (hoặc chưa có dữ liệu).'}
                      </td>
                    </tr>
                  )}
                  {balanceDetailByProject.length > 0 && balanceDetailVisible.length === 0 && (
                    <tr>
                      <td colSpan={10} className="border border-slate-300 px-4 py-8 text-center text-slate-500 font-medium">
                        Không có dự án nào khớp từ khóa «{detailProjectSearch.trim()}» (mã hoặc tên).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {detailTotalPages > 1 && (
                <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-slate-200">
                  <p className="text-[11px] font-semibold text-slate-600">
                    {balanceDetailVisible.length} dự án — hiển thị {detailPageOffset + 1}–
                    {Math.min(detailPageOffset + DETAIL_PROJECTS_PAGE_SIZE, balanceDetailVisible.length)}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={detailModalPage <= 1}
                      onClick={() => setDetailModalPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-[11px] font-bold bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft size={16} /> Trước
                    </button>
                    <span className="text-[11px] font-black text-slate-800 min-w-[4.5rem] text-center">
                      {detailModalPage} / {detailTotalPages}
                    </span>
                    <button
                      type="button"
                      disabled={detailModalPage >= detailTotalPages}
                      onClick={() => setDetailModalPage((p) => Math.min(detailTotalPages, p + 1))}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-[11px] font-bold bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Sau <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      )}

      {isTxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-in fade-in zoom-in duration-200">
          <GlassCard className="w-full max-w-md bg-white p-6 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold">Giao dịch dòng tiền</h3>
              <button onClick={() => setIsTxModalOpen(false)}><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div className="flex gap-2 p-1 bg-slate-100 rounded-lg">
                <button onClick={() => setTxType(BankTransactionType.DEPOSIT)} className={`flex-1 py-2 text-xs font-bold rounded ${txType === BankTransactionType.DEPOSIT ? 'bg-white text-emerald-600 shadow' : 'text-slate-500'}`}>NẠP TIỀN</button>
                <button onClick={() => setTxType(BankTransactionType.WITHDRAW)} className={`flex-1 py-2 text-xs font-bold rounded ${txType === BankTransactionType.WITHDRAW ? 'bg-white text-rose-600 shadow' : 'text-slate-500'}`}>RÚT TIỀN</button>
              </div>
              <input type="text" value={txAmount} onChange={handleAmountChange} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-lg font-bold" placeholder="Nhập số tiền (ví dụ: 1,000,000)..." inputMode="numeric" />
              <textarea value={txNote} onChange={e => setTxNote(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-sm h-24" placeholder="Nội dung..." />
              <button onClick={handleTxSubmit} className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg">Xác nhận giao dịch</button>
            </div>
          </GlassCard>
        </div>
      )}
    </div>
  );
};
