import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '../components/GlassCard';
import { formatDate } from '../utils/helpers';
import { api, DecisionPdfListItem } from '../services/api';
import { FileUp, Loader2, Trash2, ExternalLink, FileText, Search } from 'lucide-react';
import { User } from '../types';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result as string;
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(new Error('Đọc file thất bại'));
    reader.readAsDataURL(file);
  });
}

async function openPdfWithAuth(id: string): Promise<void> {
  const token = localStorage.getItem('auth_token');
  const res = await fetch(api.decisionPdfs.fileUrl(id), {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    const t = await res.text();
    let msg = 'Không mở được PDF';
    try {
      const j = JSON.parse(t);
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const ab = await res.arrayBuffer();
  const blob = new Blob([ab], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) {
    URL.revokeObjectURL(url);
    throw new Error('Trình duyệt đã chặn cửa sổ mới — hãy cho phép popup hoặc thử lại.');
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

interface PdfDecisionScansProps {
  currentUser: User;
  readOnlyStaff?: boolean;
}

export const PdfDecisionScans: React.FC<PdfDecisionScansProps> = ({ currentUser, readOnlyStaff = false }) => {
  const [rows, setRows] = useState<DecisionPdfListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [listSearch, setListSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const name = (r.originalFileName || '').toLowerCase();
      const n = (r.note || '').toLowerCase();
      return name.includes(q) || n.includes(q);
    });
  }, [rows, listSearch]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.decisionPdfs.list();
      setRows(res.data || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Không tải được danh sách');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (readOnlyStaff) {
      alert('Tài khoản đang khóa chỉnh sửa.');
      return;
    }
    if (file.type !== 'application/pdf') {
      alert('Chỉ upload file PDF.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const b64 = await fileToBase64(file);
      await api.decisionPdfs.upload({
        fileName: file.name,
        pdfBase64: b64,
        note: note.trim() || undefined
      });
      setNote('');
      await load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Upload thất bại');
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (id: string) => {
    if (readOnlyStaff) {
      alert('Tài khoản đang khóa chỉnh sửa.');
      return;
    }
    if (!window.confirm('Xóa bản scan PDF này khỏi hệ thống?')) return;
    try {
      await api.decisionPdfs.delete(id);
      await load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Xóa thất bại');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in pb-12">
      <div>
        <h2 className="text-2xl font-medium text-black tracking-tight">PDF quyết định</h2>
        <p className="text-sm font-medium text-slate-500 mt-1">
          Upload bản scan PDF quyết định — lưu trực tiếp trên cơ sở dữ liệu (theo đơn vị: {currentUser.organization || '—'}).
        </p>
      </div>

      <GlassCard className="p-6 border-slate-200">
        <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide mb-4 flex items-center gap-2">
          <FileUp size={18} className="text-blue-600" />
          Tải lên file mới
        </h3>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 text-sm font-bold cursor-pointer hover:bg-blue-100 disabled:opacity-50">
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
            Chọn file PDF
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              disabled={readOnlyStaff || uploading}
              onChange={onPickFile}
            />
          </label>
          <div className="flex-1 w-full max-w-md">
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Ghi chú (tùy chọn)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={readOnlyStaff}
              placeholder="Ví dụ: QĐ số …, ngày …"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800"
            />
          </div>
        </div>
      </GlassCard>

      <GlassCard className="p-0 overflow-hidden border-slate-200">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/80 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3 flex-1 min-w-0">
            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide shrink-0">Đã lưu</h3>
            <div className="flex flex-col gap-1 flex-1 min-w-[180px] max-w-md">
              <label htmlFor="pdf-list-search" className="text-[10px] font-bold text-slate-500 uppercase">
                Tìm theo tên file / ghi chú
              </label>
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="pdf-list-search"
                  type="search"
                  value={listSearch}
                  onChange={(e) => setListSearch(e.target.value)}
                  placeholder="Nhập tên file hoặc ghi chú..."
                  className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2 py-2 text-xs font-semibold text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load()}
            className="text-xs font-bold text-blue-700 hover:underline shrink-0 self-start sm:self-auto"
          >
            Làm mới
          </button>
        </div>
        {loading ? (
          <div className="p-12 flex justify-center text-slate-500">
            <Loader2 className="animate-spin" size={28} />
          </div>
        ) : error ? (
          <div className="p-8 text-center text-rose-600 font-medium">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-slate-500 font-medium">Chưa có file nào.</div>
        ) : filteredRows.length === 0 ? (
          <div className="p-12 text-center text-slate-500 font-medium">
            Không có file nào khớp «{listSearch.trim()}» (tên file hoặc ghi chú).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-[10px] uppercase font-bold text-slate-600 bg-slate-100 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">Tên file</th>
                  <th className="px-4 py-3">Ghi chú</th>
                  <th className="px-4 py-3 text-right">Dung lượng</th>
                  <th className="px-4 py-3">Người upload</th>
                  <th className="px-4 py-3">Ngày</th>
                  <th className="px-4 py-3 text-center w-36">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3 font-semibold text-slate-900">{r.originalFileName}</td>
                    <td className="px-4 py-3 text-slate-600 text-xs max-w-xs truncate" title={r.note}>
                      {r.note || '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatBytes(r.sizeBytes)}</td>
                    <td className="px-4 py-3 text-xs font-medium text-slate-700">{r.uploadedByName}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">{formatDate(r.createdAt)}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => openPdfWithAuth(r.id).catch((e) => alert(e.message))}
                          className="p-1.5 rounded-lg border border-slate-200 text-blue-700 hover:bg-blue-50"
                          title="Mở PDF"
                        >
                          <ExternalLink size={16} />
                        </button>
                        <button
                          type="button"
                          disabled={readOnlyStaff}
                          onClick={() => onDelete(r.id)}
                          className="p-1.5 rounded-lg border border-slate-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                          title="Xóa"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
};
