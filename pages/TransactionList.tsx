
import React, { useState, useMemo } from 'react';
import { Transaction, Project, TransactionStatus, User } from '../types';
import { GlassCard } from '../components/GlassCard';
import { StatusBadge } from '../components/StatusBadge';
import { PrintPhieuChi } from '../components/PrintPhieuChi';
import { PrintPhieuChiBatch } from '../components/PrintPhieuChiBatch';
import { formatCurrency, formatDate, calculateInterest, calculateInterestWithRateChange, exportTransactionsToExcel, roundTo2, roundHalfUp } from '../utils/helpers';
import { Search, Filter, Download, Folder, Users, CheckCircle, Clock, DollarSign, PiggyBank, ChevronLeft, ChevronRight, Eye, FileText, Printer, Trash2 } from 'lucide-react';
import api from '../services/api';

interface TransactionListProps {
  transactions: Transaction[];
  projects: Project[];
  interestRate: number;
  interestRateChangeDate?: string | null;
  interestRateBefore?: number | null;
  interestRateAfter?: number | null;
  currentUser: User;
  onSelect: (t: Transaction) => void;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  onDelete?: () => void; // Callback to refresh data after deletion
}

export const TransactionList: React.FC<TransactionListProps> = ({ 
  transactions, 
  projects, 
  interestRate, 
  interestRateChangeDate,
  interestRateBefore,
  interestRateAfter,
  currentUser, 
  onSelect, 
  searchTerm, 
  setSearchTerm, 
  onDelete 
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;
  const [printTransaction, setPrintTransaction] = useState<Transaction | null>(null);
  const [selectedTransactions, setSelectedTransactions] = useState<Set<string>>(new Set());
  const [showBatchPrint, setShowBatchPrint] = useState(false);
  const [startDate, setStartDate] = useState(''); // ISO yyyy-mm-dd
  const [endDate, setEndDate] = useState(''); // ISO yyyy-mm-dd
  const formattedStart = startDate ? formatDate(startDate) : '---';
  const formattedEnd = endDate ? formatDate(endDate) : '---';

  const resolveProject = React.useCallback((t: Transaction) => {
    const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
    return projects.find(p => (p.id === pIdStr || (p as any)._id === pIdStr));
  }, [projects]);

  const getRelevantDate = React.useCallback((t: Transaction, projectParam?: Project) => {
    const project = projectParam || resolveProject(t);
    // ALWAYS return the interest start date for filtering, regardless of disbursement status
    // This ensures transactions are filtered by their interest calculation start date,
    // not by their actual disbursement date, which may be much later
    const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
    return baseDate;
  }, [resolveProject]);

  const isDateWithinRange = React.useCallback((dateStr?: string) => {
    if (!dateStr) return false;
    const value = new Date(dateStr);
    if (isNaN(value.getTime())) return false;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if (start && value < start) return false;
    if (end) {
      const endOfDay = new Date(end);
      endOfDay.setHours(23, 59, 59, 999);
      if (value > endOfDay) return false;
    }
    return true;
  }, [startDate, endDate]);

  const isTransactionInDateRange = React.useCallback((t: Transaction, project?: Project) => {
    if (!startDate && !endDate) return true;
    const interestDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
    if (isDateWithinRange(interestDate)) return true;
    if (t.disbursementDate && isDateWithinRange(t.disbursementDate)) return true;
    return false;
  }, [startDate, endDate, isDateWithinRange]);

  // Point-in-Time helpers: Determine effective status and calculation date at filter time
  const getEffectiveStatus = React.useCallback((t: Transaction): TransactionStatus => {
    // If no end date filter, return actual status
    if (!endDate) return t.status;
    
    // If transaction has disbursementDate and it's AFTER the filter end date,
    // treat it as NOT disbursed (point-in-time view)
    if (t.disbursementDate) {
      const disbursementDateTime = new Date(t.disbursementDate).getTime();
      const filterEndTime = new Date(endDate).setHours(23, 59, 59, 999);
      
      if (disbursementDateTime > filterEndTime) {
        // At filter time, this transaction was not yet disbursed
        return TransactionStatus.PENDING;
      }
    }
    
    // Otherwise return actual status
    return t.status;
  }, [endDate]);

  const getEffectiveCalculationDate = React.useCallback((t: Transaction): Date => {
    // If no end date filter, use current logic
    if (!endDate) {
      if (t.status === TransactionStatus.DISBURSED && t.disbursementDate) {
        return new Date(t.disbursementDate);
      }
      return new Date(); // Current date for pending
    }
    
    // With filter: check if transaction was disbursed at filter time
    const effectiveStatus = getEffectiveStatus(t);
    
    if (effectiveStatus === TransactionStatus.DISBURSED && t.disbursementDate) {
      // Was disbursed before filter date, use disbursementDate
      return new Date(t.disbursementDate);
    } else {
      // Was not disbursed at filter time, use filter end date
      const filterEnd = new Date(endDate);
      filterEnd.setHours(23, 59, 59, 999);
      return filterEnd;
    }
  }, [endDate, getEffectiveStatus]);

  // Filter Data
  const filtered = useMemo(() => {
    // Hỗ trợ nhiều điều kiện, cách nhau bởi dấu "," hoặc ":"
    const rawTerms = searchTerm
      .split(/[,:\uFF0C]/) // bao gồm dấu phẩy tiếng Việt toàn chiều
      .map(t => t.trim())
      .filter(t => t.length > 0);

    return transactions.filter(t => {
      const project = resolveProject(t);
      if (!isTransactionInDateRange(t, project)) return false;

      const relevantDate = getRelevantDate(t, project);
      const displayDateStr = relevantDate ? formatDate(relevantDate) : '';

      // Nếu không nhập gì thì không lọc theo search
      if (rawTerms.length === 0) return true;

      // Một giao dịch phải thỏa MỌI điều kiện (AND) trong chuỗi search
      return rawTerms.every(termRaw => {
        const term = termRaw.toLowerCase();
        
        // Tính toán số tiền để search — khớp logic Point-in-Time + Rate Change với bảng/stats
        const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
        const baseDate = t.effectiveInterestDate || project?.interestStartDate;
        const searchEffectiveStatus = getEffectiveStatus(t);
        const searchCalcDate = getEffectiveCalculationDate(t);

        let interest = 0;
        const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;
        if (hasRateChange) {
          const result = calculateInterestWithRateChange(principalBase, baseDate, searchCalcDate, interestRateChangeDate, interestRateBefore, interestRateAfter);
          interest = result.totalInterest;
        } else {
          interest = calculateInterest(principalBase, interestRate, baseDate, searchCalcDate);
        }
        const supplementary = t.supplementaryAmount || 0;
        const totalAmount = principalBase + interest + supplementary;
        
        // Format số tiền để search (loại bỏ dấu phẩy và khoảng trắng)
        const formatAmountForSearch = (amount: number) => {
          return roundHalfUp(amount, 0).toString().replace(/\s/g, '');
        };
        const totalApprovedStr = formatAmountForSearch(t.compensation.totalApproved || 0);
        const interestStr = formatAmountForSearch(interest);
        const totalAmountStr = formatAmountForSearch(totalAmount);
        const supplementaryStr = formatAmountForSearch(supplementary);
        
        // Loại bỏ dấu phẩy và khoảng trắng từ search term để so sánh số
        const numericTerm = termRaw.replace(/[,.\s]/g, '');
        
        const effectiveStatusStr = getEffectiveStatus(t);
        return (
          effectiveStatusStr.toLowerCase().includes(term) || // Search by effective Status (point-in-time)
          t.household.name.toLowerCase().includes(term) || // Search by Name
          t.household.cccd.includes(termRaw) || // CCCD giữ nguyên (thường nhập số)
          t.household.decisionNumber.toLowerCase().includes(term) || // Search by Decision Number
          t.id.toLowerCase().includes(term) || // Search by Transaction ID
          displayDateStr.includes(termRaw) || // Search by Displayed Date (Expected or Actual)
          (t.paymentType && t.paymentType.toLowerCase().includes(term)) || // Search by Payment Type
          (typeof t.projectId === 'string' && t.projectId.toLowerCase().includes(term)) ||
          project?.code.toLowerCase().includes(term) ||
          // Search by Amount (số tiền)
          totalApprovedStr.includes(numericTerm) || // Tổng phê duyệt
          interestStr.includes(numericTerm) || // Lãi phát sinh
          totalAmountStr.includes(numericTerm) || // Tổng thực nhận
          supplementaryStr.includes(numericTerm) // Tiền bổ sung
        );
      });
    });
  }, [transactions, searchTerm, resolveProject, getRelevantDate, isTransactionInDateRange, getEffectiveStatus, getEffectiveCalculationDate, interestRate, interestRateChangeDate, interestRateBefore, interestRateAfter]);

  // Statistics Calculations based on Filtered Data
  const stats = useMemo(() => {
    const uniqueProjects = new Set(filtered.map(t => (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString())).size;
    // Use effective status at filter time instead of actual status
    const disbursedItems = filtered.filter(t => getEffectiveStatus(t) === TransactionStatus.DISBURSED);
    const notDisbursedItems = filtered.filter(t => getEffectiveStatus(t) !== TransactionStatus.DISBURSED);

    // UPDATE: Disbursed Money includes interest paid + supplementary amount
    // Bao gồm cả tiền đã rút một phần từ các giao dịch chưa giải ngân hoàn toàn
    const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;
    
    // 1. Tiền đã giải ngân hoàn toàn (DISBURSED at filter time)
    const moneyDisbursedRawFromDisbursed = disbursedItems.reduce((sum, t) => {
      const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
      const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
      const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
      const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
      
      // Use effective calculation date (respects filter date)
      const calcDate = getEffectiveCalculationDate(t);
      
      let interest = 0;
      if (hasRateChange) {
        const interestResult = calculateInterestWithRateChange(
          principalBase,
          baseDate,
          calcDate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter
        );
        interest = interestResult.totalInterest;
      } else {
        interest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
      }
      
      const supplementary = t.supplementaryAmount || 0;
      return sum + principalBase + interest + supplementary;
    }, 0);

    // 2. Tiền đã rút một phần từ các giao dịch chưa giải ngân hoàn toàn (PENDING/HOLD)
    const moneyDisbursedRawFromPartial = notDisbursedItems
      .filter(t => (t as any).withdrawnAmount && (t as any).withdrawnAmount > 0)
      .reduce((sum, t) => {
        const withdrawn = (t as any).withdrawnAmount || 0;
        return sum + withdrawn;
      }, 0);

    const moneyDisbursedRaw = moneyDisbursedRawFromDisbursed + moneyDisbursedRawFromPartial;

    // UPDATE: Pending Money includes accrued interest for HOLD items + supplementary amount
    // Nếu đã rút một phần, chỉ tính trên phần còn lại (principalForInterest) để tránh tính trùng
    const moneyNotDisbursedRaw = notDisbursedItems.reduce((sum, t) => {
      const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
      const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
      const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
      // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (phần còn lại)
      const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
      
      // Use effective calculation date (respects filter date)
      const calcDate = getEffectiveCalculationDate(t);
      
      let interest = 0;
      if (hasRateChange) {
        const interestResult = calculateInterestWithRateChange(
          principalBase,
          baseDate,
          calcDate,
          interestRateChangeDate,
          interestRateBefore,
          interestRateAfter
        );
        interest = interestResult.totalInterest;
      } else {
        interest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
      }
      
      const supplementary = t.supplementaryAmount || 0;
      // Tính trên phần gốc còn lại (principalBase) + lãi + bổ sung
      return sum + principalBase + interest + supplementary;
    }, 0);

    // Calculate Interest logic for Stats - Link với tab Tổng quan / tab Số dư
    // CHỈ tính lãi từ các giao dịch CHƯA giải ngân (PENDING + HOLD) - Lãi tạm tính
    // Khi giải ngân, lãi của giao dịch đó sẽ được chuyển sang "đã chốt" và không còn trong tổng này
    let tempInterest = 0; // Lãi tạm tính (chưa giải ngân) - giữ 2 chữ số thập phân
    let lockedInterest = 0; // Lãi đã chốt (đã giải ngân) - giữ 2 chữ số thập phân

    filtered.forEach(t => {
      const pIdStr = (t.projectId && (t.projectId as any)._id) ? (t.projectId as any)._id.toString() : t.projectId?.toString();
      const project = projects.find(p => (p.id === pIdStr || p._id === pIdStr));
      const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
      // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (phần còn lại)
      const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
      
      // Use effective status at filter time
      const effectiveStatus = getEffectiveStatus(t);
      const calcDate = getEffectiveCalculationDate(t);

      if (effectiveStatus === TransactionStatus.DISBURSED) {
        // Lãi đã chốt (tại thời điểm filter)
        let interestForTransaction = 0;
        if (hasRateChange) {
          const interestResult = calculateInterestWithRateChange(
            principalBase,
            baseDate,
            calcDate,
            interestRateChangeDate,
            interestRateBefore,
            interestRateAfter
          );
          interestForTransaction = interestResult.totalInterest;
        } else {
          interestForTransaction = calculateInterest(principalBase, interestRate, baseDate, calcDate);
        }
        lockedInterest += interestForTransaction;
      } else {
        // Lãi tạm tính (chưa giải ngân tại thời điểm filter)
        // Tính trên phần gốc còn lại (principalForInterest) để tránh tính trùng
        let interestForTransaction = 0;
        if (hasRateChange) {
          const interestResult = calculateInterestWithRateChange(
            principalBase,
            baseDate,
            calcDate,
            interestRateChangeDate,
            interestRateBefore,
            interestRateAfter
          );
          interestForTransaction = interestResult.totalInterest;
        } else {
          interestForTransaction = calculateInterest(principalBase, interestRate, baseDate, calcDate);
        }
        tempInterest += interestForTransaction;
      }
    });

    const totalInterest = tempInterest; // Chỉ trả về lãi tạm tính (chưa làm tròn)

    // Làm tròn kết quả tổng cho hiển thị (2 chữ số thập phân)
    const moneyDisbursed = roundTo2(moneyDisbursedRaw);
    const moneyNotDisbursed = roundTo2(moneyNotDisbursedRaw);

    return {
      uniqueProjects,
      disbursedCount: disbursedItems.length,
      notDisbursedCount: notDisbursedItems.length,
      moneyDisbursed,
      moneyNotDisbursed,
      accruedInterest: roundTo2(totalInterest),
      lockedInterest: roundTo2(lockedInterest) // Lãi đã chốt (để hiển thị)
    };
  }, [filtered, interestRate, projects, interestRateChangeDate, interestRateBefore, interestRateAfter, getEffectiveStatus, getEffectiveCalculationDate]);

  // Pagination Logic
  const totalPages = Math.ceil(filtered.length / itemsPerPage);
  const paginatedData = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  const handleDownload = () => {
    // Export filtered transactions based on current search and date filters
    // Pass date filters to ensure Excel matches UI display (Point-in-Time logic)
    exportTransactionsToExcel(
      filtered, 
      projects, 
      interestRate, 
      interestRateChangeDate, 
      interestRateBefore, 
      interestRateAfter,
      endDate || null  // Pass endDate for Point-in-Time calculations
    );
  };

  const StatBox = ({ label, value, subValue, icon: Icon, colorClass }: any) => (
    <GlassCard className="p-4 flex flex-col justify-between border-slate-200 min-h-[100px] shadow-sm">
      <div className="flex justify-between items-start mb-2">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">{label}</span>
        <Icon size={16} className={colorClass} strokeWidth={2.5} />
      </div>
      <div className="flex flex-col">
        <span className="text-lg font-bold text-slate-900 block">{value}</span>
        <span className="text-[10px] font-medium text-slate-500 min-h-[14px]">{subValue || '\u00A0'}</span>
      </div>
    </GlassCard>
  );

  return (
    <div className="space-y-6 animate-fade-in pb-10">
      <div className="flex justify-between items-end pb-2">
        <div>
          <h2 className="text-2xl font-medium text-black tracking-tight">Danh sách giao dịch</h2>
          <p className="text-sm font-medium text-slate-500 mt-1">Quản lý chi tiết từng hộ dân</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleDownload}
            className="p-2 bg-white/60 hover:bg-white border border-slate-200 rounded-lg text-slate-600 transition-all shadow-sm group"
            title="Tải xuống Excel"
          >
            <Download size={18} className="group-hover:text-blue-600" />
          </button>
        </div>
      </div>

      {/* KPI Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatBox
          label="Tổng dự án"
          value={stats.uniqueProjects}
          subValue="Trong bộ lọc"
          icon={Folder}
          colorClass="text-blue-600"
        />
        <StatBox
          label="Hộ đã GN"
          value={stats.disbursedCount}
          subValue="Đã hoàn tất"
          icon={CheckCircle}
          colorClass="text-emerald-600"
        />
        <StatBox
          label="Hộ chưa GN"
          value={stats.notDisbursedCount}
          subValue="Đang chờ"
          icon={Clock}
          colorClass="text-amber-600"
        />
        <StatBox
          label="Tiền đã GN"
          value={formatCurrency(stats.moneyDisbursed)}
          icon={DollarSign}
          colorClass="text-emerald-600"
        />
        <StatBox
          label="Tiền chưa GN"
          value={formatCurrency(stats.moneyNotDisbursed)}
          icon={Users}
          colorClass="text-amber-600"
        />
        <StatBox
          label="Tổng lãi PS"
          value={formatCurrency(stats.accruedInterest)}
          subValue={stats.lockedInterest > 0 ? `Đã chốt: ${formatCurrency(stats.lockedInterest)}` : "Lãi tạm tính"}
          icon={PiggyBank}
          colorClass="text-rose-600"
        />
      </div>

      {/* Search Bar */}
      <GlassCard className="p-4 flex gap-4 items-center border-slate-200">
        <div className="w-full flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex-1 min-w-[240px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                placeholder="Tìm theo Trạng thái, Tên, Mã GD, Số QĐ, Số tiền... (có thể nhập nhiều điều kiện, cách nhau bởi dấu , hoặc :)"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-4 py-2 text-sm font-bold text-black focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all placeholder:text-slate-400"
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              />
            </div>
            {selectedTransactions.size > 0 && (
              <>
                <button
                  onClick={() => setShowBatchPrint(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700 transition-colors shadow-sm"
                >
                  <Printer size={16} />
                  <span>In hàng loạt ({selectedTransactions.size})</span>
                </button>
                <button
                  onClick={async () => {
                    const pendingIds = Array.from(selectedTransactions).filter(id => {
                      const t = transactions.find(tx => tx.id === id);
                      return t && t.status !== TransactionStatus.DISBURSED;
                    });

                    if (pendingIds.length === 0) {
                      alert('Tất cả giao dịch đã chọn đều đã giải ngân rồi.');
                      return;
                    }

                    const skippedCount = selectedTransactions.size - pendingIds.length;
                    let confirmMsg = `Xác nhận giải ngân ${pendingIds.length} giao dịch?\n\nHệ thống sẽ:\n• Chốt lãi và chuyển trạng thái sang "Đã giải ngân"\n• Tạo giao dịch rút tiền ngân hàng tương ứng\n• Ngừng tính lãi cho các giao dịch này`;
                    if (skippedCount > 0) {
                      confirmMsg += `\n\n(${skippedCount} giao dịch đã giải ngân sẽ được bỏ qua)`;
                    }
                    if (!window.confirm(confirmMsg)) return;

                    try {
                      const results: { success: boolean; id: string; error?: string }[] = [];
                      for (const id of pendingIds) {
                        try {
                          await api.transactions.updateStatus(id, TransactionStatus.DISBURSED, currentUser.name);
                          results.push({ success: true, id });
                        } catch (err: any) {
                          console.error(`Failed to disburse transaction ${id}:`, err);
                          results.push({ success: false, id, error: err.message });
                        }
                      }
                      const successCount = results.filter(r => r.success).length;
                      const failCount = results.length - successCount;

                      if (failCount > 0) {
                        alert(`Đã giải ngân ${successCount} giao dịch thành công.\n${failCount} giao dịch thất bại.`);
                      } else {
                        alert(`Đã giải ngân thành công ${successCount} giao dịch!`);
                      }

                      setSelectedTransactions(new Set());
                      if (onDelete) onDelete();
                    } catch (error: any) {
                      console.error('Batch disbursement error:', error);
                      alert('Lỗi khi giải ngân hàng loạt: ' + (error.message || 'Unknown error'));
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors shadow-sm"
                >
                  <CheckCircle size={16} />
                  <span>Giải ngân hàng loạt ({selectedTransactions.size})</span>
                </button>
                <button
                  onClick={async () => {
                    if (selectedTransactions.size === 0) return;
                    
                    const confirmMsg = `Bạn có chắc chắn muốn xóa ${selectedTransactions.size} giao dịch đã chọn?\n\nHành động này không thể hoàn tác.`;
                    if (!window.confirm(confirmMsg)) return;

                    try {
                      // Delete transactions SEQUENTIALLY to ensure runningBalance is calculated correctly
                      // Parallel deletion causes runningBalance calculation errors
                      const results = [];
                      for (const id of Array.from(selectedTransactions)) {
                        try {
                          const result = await api.transactions.delete(id);
                          results.push({ success: true, ...result });
                        } catch (err: any) {
                          console.error(`Failed to delete transaction ${id}:`, err);
                          results.push({ success: false, id, error: err.message });
                        }
                      }
                      const successCount = results.filter(r => r.success !== false).length;
                      const failCount = results.length - successCount;

                      if (failCount > 0) {
                        alert(`Đã xóa ${successCount} giao dịch thành công. ${failCount} giao dịch xóa thất bại.`);
                      } else {
                        alert(`Đã xóa ${successCount} giao dịch thành công!`);
                      }

                      // Clear selection
                      setSelectedTransactions(new Set());
                      
                      // Refresh data
                      if (onDelete) {
                        onDelete();
                      }
                    } catch (error: any) {
                      console.error('Error deleting transactions:', error);
                      alert('Lỗi khi xóa giao dịch: ' + (error.message || 'Unknown error'));
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 transition-colors shadow-sm"
                >
                  <Trash2 size={16} />
                  <span>Xóa giao dịch ({selectedTransactions.size})</span>
                </button>
              </>
            )}
            <button className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors shadow-sm">
              <Filter size={16} />
              <span>Bộ lọc</span>
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col">
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Từ ngày</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-black shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Đến ngày</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-black shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">
                Đang lọc: {formattedStart} → {formattedEnd}
              </span>
              <span className="text-slate-500">({filtered.length} giao dịch khớp)</span>
            </div>
            {(startDate || endDate) && (
              <button
                onClick={() => { setStartDate(''); setEndDate(''); setCurrentPage(1); }}
                className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-50 shadow-sm"
              >
                Xóa lọc
              </button>
            )}
          </div>
        </div>
      </GlassCard>

      {/* Data Table */}
      <GlassCard className="overflow-hidden p-0 border-slate-300 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="text-[10px] text-slate-700 uppercase font-bold bg-slate-100 border-b border-slate-200 backdrop-blur-sm sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3.5 border-r border-slate-200 text-center w-12">
                  <input
                    type="checkbox"
                    checked={paginatedData.length > 0 && paginatedData.every(t => selectedTransactions.has(t.id))}
                    onChange={(e) => {
                      if (e.target.checked) {
                        const newSet = new Set(selectedTransactions);
                        paginatedData.forEach(t => newSet.add(t.id));
                        setSelectedTransactions(newSet);
                      } else {
                        const newSet = new Set(selectedTransactions);
                        paginatedData.forEach(t => newSet.delete(t.id));
                        setSelectedTransactions(newSet);
                      }
                    }}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                </th>
                <th className="px-4 py-3.5 border-r border-slate-200 text-center w-12">STT</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[100px]">Mã GD</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[120px]">Mã Hộ Dân</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[200px]">Mã Dự Án</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[150px]">Họ và tên</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[180px]">Loại chi trả</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[120px]">Số quyết định</th>
                <th className="px-4 py-3.5 border-r border-slate-200 min-w-[130px]">Ngày GN</th>
                <th className="px-4 py-3.5 text-right border-r border-slate-200 min-w-[130px]">Tổng phê duyệt</th>
                <th className="px-4 py-3.5 text-right border-r border-slate-200 min-w-[120px]">Lãi phát sinh</th>
                <th className="px-4 py-3.5 text-right border-r border-slate-200 min-w-[120px]">Tiền bổ sung</th>
                <th className="px-4 py-3.5 text-right border-r border-slate-200 min-w-[130px]">Tổng chi trả</th>
                <th className="px-4 py-3.5 text-right border-r border-slate-200 min-w-[130px]">Tiền còn lại</th>
                <th className="px-4 py-3.5 border-r border-slate-200 text-center min-w-[120px]">Trạng thái</th>
                <th className="px-4 py-3.5 text-center min-w-[80px]">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-300">
              {paginatedData.map((t, index) => {

                const project = resolveProject(t);
                // Use effective status at filter time
                const effectiveStatus = getEffectiveStatus(t);
                const isDisbursed = effectiveStatus === TransactionStatus.DISBURSED;

                // --- INTEREST CALCULATION LOGIC (Point-in-Time) ---
                // Nếu đã rút một phần, dùng principalForInterest làm gốc tính lãi (để tính lãi kép trên phần còn lại)
                const principalBase = (t as any).principalForInterest ?? t.compensation.totalApproved;
                const baseDate = t.effectiveInterestDate || project?.interestStartDate || (project as any)?.startDate;
                
                // Use effective calculation date (respects filter date)
                const calcDate = getEffectiveCalculationDate(t);
                
                let currentInterest = 0;

                // Use rate change calculation if configured
                const hasRateChange = interestRateChangeDate && interestRateBefore !== null && interestRateAfter !== null;

                if (hasRateChange) {
                  const interestResult = calculateInterestWithRateChange(
                    principalBase,
                    baseDate,
                    calcDate,
                    interestRateChangeDate,
                    interestRateBefore,
                    interestRateAfter
                  );
                  currentInterest = interestResult.totalInterest;
                } else {
                  currentInterest = calculateInterest(principalBase, interestRate, baseDate, calcDate);
                }

                const supplementary = t.supplementaryAmount || 0;
                const totalAvailable = principalBase + currentInterest + supplementary;
                
                // Tổng chi trả:
                // - Chưa GN: luôn dùng totalAvailable để SUM khớp stats "Tiền chưa GN"
                // - Đã GN: ưu tiên disbursedTotal (đã chốt), nhưng nếu dữ liệu cũ bị làm tròn mất phần lẻ
                //   thì fallback sang totalAvailable (gốc + lãi + bổ sung) tính lại theo đúng ngày chốt.
                const storedDisbursedTotal = Number((t as any).disbursedTotal);
                const computedTotalPaid = roundTo2(totalAvailable);
                const displayTotalPaid =
                  isDisbursed && isFinite(storedDisbursedTotal) && storedDisbursedTotal > 0
                    ? (Math.abs(roundTo2(storedDisbursedTotal) - computedTotalPaid) >= 0.01
                        ? computedTotalPaid
                        : roundTo2(storedDisbursedTotal))
                    : computedTotalPaid;
                const withdrawnAmount = (t as any).withdrawnAmount || 0;
                
                // Tiền còn lại: chỉ hiển thị nếu đã rút một phần
                // Tính tổng tiền thực nhận mới (đã bao gồm cả lãi mới phát sinh từ ngày rút đến hiện tại)
                const remainingCol = (t as any).remainingAfterWithdraw !== undefined && (t as any).withdrawnAmount
                  ? totalAvailable  // Tổng tiền thực nhận mới = principalForInterest + lãi_mới + supplementary
                  : null;

                // --- DISPLAY DATE LOGIC ---
                // Nếu đã GN: Hiện ngày thực tế
                // Nếu chưa GN: Hiện ngày dự kiến (effectiveInterestDate hoặc interestStartDate của dự án)
                const relevantDate = getRelevantDate(t, project);
                let displayDateStr = relevantDate ? formatDate(relevantDate) : '-';
                let dateNote = '';
                let dateColorClass = 'text-slate-500';

                if (isDisbursed && t.disbursementDate) {
                  displayDateStr = formatDate(t.disbursementDate);
                  dateNote = 'Thực tế';
                  dateColorClass = 'text-emerald-700 font-bold';
                } else if (baseDate) {
                  displayDateStr = formatDate(baseDate);
                  // Nếu có effectiveInterestDate nghĩa là đã qua nạp tiền/reset, thì là ngày tính lãi mới
                  dateNote = t.effectiveInterestDate ? 'Ngày nạp quỹ' : 'Dự kiến';
                  dateColorClass = 'text-slate-600 font-semibold';
                }

                return (
                  <tr
                    key={t.id}
                    className="hover:bg-blue-50/50 transition-colors cursor-pointer group odd:bg-white even:bg-slate-50/30"
                    onClick={() => onSelect(t)}
                  >
                    <td className="px-4 py-3 border-r border-slate-200 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedTransactions.has(t.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          const newSet = new Set(selectedTransactions);
                          if (e.target.checked) {
                            newSet.add(t.id);
                          } else {
                            newSet.delete(t.id);
                          }
                          setSelectedTransactions(newSet);
                        }}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200 text-center font-bold text-slate-600">
                      {(currentPage - 1) * itemsPerPage + index + 1}
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <span className="font-bold text-slate-800 text-xs">{t.id}</span>
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200 font-mono text-[11px] font-bold text-slate-500">
                      {t.household.id}
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <span className="text-xs font-bold bg-blue-50 px-2 py-1 rounded text-blue-700">
                        {project ? project.code : (t.projectId as any).toString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <span className="text-slate-900 font-bold text-[13px] group-hover:text-blue-700 transition-colors block">{t.household.name}</span>
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <span className="text-[11px] font-bold text-slate-600 bg-slate-50 px-2 py-0.5 rounded">
                        {t.paymentType || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <span className="text-xs font-bold text-slate-700">{t.household?.decisionNumber || '-'}</span>
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200">
                      <div className="flex flex-col">
                        <span className={`text-xs ${dateColorClass}`}>{displayDateStr}</span>
                        <span className="text-[10px] text-slate-400 italic font-medium">{dateNote}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-800 border-r border-slate-200">
                      {formatCurrency(principalBase)}
                      {(t as any).principalForInterest && (t as any).principalForInterest !== t.compensation.totalApproved && (
                        <span className="block text-[10px] font-medium text-slate-400">Gốc: {formatCurrency(t.compensation.totalApproved)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-rose-600 border-r border-slate-200">
                      {currentInterest > 0 ? `+${formatCurrency(currentInterest)}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-bold border-r border-slate-200">
                      {supplementary !== 0 ? (
                        <span className={supplementary > 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          {supplementary > 0 ? '+' : ''}{formatCurrency(supplementary)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-blue-700 border-r border-slate-200 bg-blue-50/30">
                      <span className="block">{formatCurrency(displayTotalPaid)}</span>
                      {withdrawnAmount > 0 && !isDisbursed && (
                        <span className="block text-[10px] font-medium text-orange-600">Đã rút: {formatCurrency(withdrawnAmount)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-bold border-r border-slate-200">
                      {remainingCol !== null ? (
                        <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded">
                          {formatCurrency(remainingCol)}
                        </span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 border-r border-slate-200 text-center">
                      <div className="flex items-center justify-center">
                        <StatusBadge status={effectiveStatus} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button className="text-slate-400 hover:text-blue-600 p-1.5 hover:bg-blue-50 rounded transition-all" title="Chi tiết">
                          <Eye size={16} strokeWidth={2.5} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPrintTransaction(t);
                          }}
                          className="text-slate-400 hover:text-green-600 p-1.5 hover:bg-green-50 rounded transition-all"
                          title="In phiếu chi"
                        >
                          <FileText size={16} strokeWidth={2.5} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <div className="p-12 text-center text-slate-400 font-medium">Không tìm thấy giao dịch phù hợp</div>
        )}

        {/* Pagination Controls */}
        <div className="p-4 bg-white/50 border-t border-slate-200 flex justify-between items-center backdrop-blur-sm">
          <div className="text-xs font-bold text-slate-500">
            Hiển thị {(currentPage - 1) * itemsPerPage + 1} - {Math.min(currentPage * itemsPerPage, filtered.length)} trên tổng số {filtered.length} bản ghi
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="p-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 transition-colors"
            >
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <div className="flex items-center justify-center px-3 bg-white border border-slate-200 rounded-lg text-xs font-bold text-blue-700 shadow-sm">
              Trang {currentPage} / {totalPages}
            </div>
            <button
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="p-1.5 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 transition-colors"
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </GlassCard>

      {/* Print Modal */}
      {printTransaction && (
        <PrintPhieuChi
          transaction={printTransaction}
          project={projects.find(p => p.id === printTransaction.projectId)}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          currentUser={currentUser}
          onClose={() => setPrintTransaction(null)}
        />
      )}

      {/* Batch Print Modal */}
      {showBatchPrint && selectedTransactions.size > 0 && (
        <PrintPhieuChiBatch
          transactions={transactions.filter(t => selectedTransactions.has(t.id))}
          projects={projects}
          interestRate={interestRate}
          interestRateChangeDate={interestRateChangeDate}
          interestRateBefore={interestRateBefore}
          interestRateAfter={interestRateAfter}
          currentUser={currentUser}
          onClose={() => {
            setShowBatchPrint(false);
            setSelectedTransactions(new Set());
          }}
        />
      )}
    </div>
  );
};
