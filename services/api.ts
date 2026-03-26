// API Service Layer - Replaces localStorage with actual API calls

const API_BASE = '/api';

// Helper for fetch with error handling
async function fetchAPI<T>(endpoint: string, options?: RequestInit & { skip401Handler?: boolean }): Promise<T> {
    const token = localStorage.getItem('auth_token');
    const skip401Handler = options?.skip401Handler;
    const { skip401Handler: _, ...fetchOptions } = options || {};

    let response: Response;
    try {
        response = await fetch(`${API_BASE}${endpoint}`, {
            ...fetchOptions,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                ...fetchOptions?.headers
            }
        });
    } catch (fetchError: any) {
        // Handle network errors (connection refused, empty response, etc.)
        const errorMessage = fetchError.message || 'Network error';
        const isConnectionError = errorMessage.includes('Failed to fetch') || 
                                 errorMessage.includes('ERR_EMPTY_RESPONSE') ||
                                 errorMessage.includes('ECONNREFUSED') ||
                                 errorMessage.includes('NetworkError');
        
        if (isConnectionError) {
            const error = new Error('Không thể kết nối đến server. Vui lòng kiểm tra:\n1. Backend server đã chạy chưa? (npm run dev:server)\n2. Server đang chạy trên port 3001?') as any;
            error.isNetworkError = true;
            error.originalError = fetchError;
            throw error;
        }
        throw fetchError;
    }

    // Some errors (404 from dev server, etc.) may return HTML; guard JSON parsing
    let rawText: string;
    try {
        rawText = await response.text();
    } catch (textError) {
        // If we can't read the response, it's likely a network issue
        const error = new Error('Không thể đọc phản hồi từ server. Vui lòng kiểm tra kết nối.') as any;
        error.isNetworkError = true;
        error.status = response.status;
        throw error;
    }

    const data = (() => {
        try {
            return rawText ? JSON.parse(rawText) : {};
        } catch {
            return { error: rawText || 'Empty response from server' };
        }
    })();

    if (!response.ok) {
        // Handle session expired (401 Unauthorized)
        if (response.status === 401) {
            localStorage.removeItem('auth_token');
            
            // If skipping 401 handler (e.g., for login endpoint), return the actual error message
            if (skip401Handler) {
                const error = new Error((data as any).error || 'Unauthorized') as any;
                error.responseData = data;
                error.status = response.status;
                throw error;
            }
            
            // Only show alert and redirect if not already on login page
            const isOnLoginPage = window.location.hash === '#/login' || window.location.pathname.includes('login');
            if (!isOnLoginPage) {
                alert('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
                // App uses HashRouter
                window.location.href = '/#/login';
            }
            throw new Error('Session expired');
        }
        
        // Handle 503 Service Unavailable (backend not running)
        if (response.status === 503) {
            const error = new Error((data as any).error || 'Backend server không khả dụng. Vui lòng khởi động server với: npm run dev:server') as any;
            error.responseData = data;
            error.status = response.status;
            error.isNetworkError = true;
            throw error;
        }
        
        // Create error with additional data for better error handling
        const error = new Error((data as any).error || 'API request failed') as any;
        error.responseData = data;
        error.status = response.status;
        throw error;
    }

    return data as T;
}

// ============ AUTH ============
export const authAPI = {
    login: async (name: string, password: string) => {
        // Skip 401 handler for login endpoint - let it return error normally
        const data = await fetchAPI<{ token: string; data: any }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ name, password }),
            skip401Handler: true
        });
        localStorage.setItem('auth_token', data.token);
        return data;
    },

    refresh: async () => {
        const data = await fetchAPI<{ token: string }>('/auth/refresh', { method: 'POST' });
        if (data?.token) {
            localStorage.setItem('auth_token', data.token);
        }
        return data;
    },

    logout: () => {
        localStorage.removeItem('auth_token');
    },

    me: () => fetchAPI<{ data: any }>('/auth/me', { skip401Handler: true }),

    isLoggedIn: () => !!localStorage.getItem('auth_token')
};

// ============ PROJECTS ============
export const projectsAPI = {
    list: () => fetchAPI<{ data: any[] }>('/projects'),

    get: (id: string) => fetchAPI<{ data: any }>(`/projects/${id}`),

    create: (project: any) => fetchAPI<{ data: any }>('/projects', {
        method: 'POST',
        body: JSON.stringify(project)
    }),

    update: (id: string, project: any) => fetchAPI<{ data: any }>(`/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify(project)
    }),

    delete: (id: string) => fetchAPI(`/projects/${id}`, { method: 'DELETE' }),

    import: (data: { fileData?: string; project?: any; transactions?: any[]; importMode?: 'create' | 'merge'; [key: string]: any }) => fetchAPI<{ data: any }>('/projects/import', {
        method: 'POST',
        body: JSON.stringify(data)
    })
};

// ============ TRANSACTIONS ============
export const transactionsAPI = {
    list: (params?: { projectId?: string; status?: string; search?: string; page?: number; limit?: number }) => {
        const query = new URLSearchParams();
        if (params?.projectId) query.set('projectId', params.projectId);
        if (params?.status) query.set('status', params.status);
        if (params?.search) query.set('search', params.search);
        if (params?.page) query.set('page', params.page.toString());
        if (params?.limit) query.set('limit', params.limit.toString());

        return fetchAPI<{ data: any[]; pagination: any }>(`/transactions?${query}`);
    },

    get: (id: string) => fetchAPI<{ data: any }>(`/transactions/${id}`),

    update: (id: string, updates: any) => fetchAPI<{ data: any }>(`/transactions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates)
    }),

    delete: (id: string) => fetchAPI<{ success: boolean; message: string; data: any }>(`/transactions/${id}`, {
        method: 'DELETE'
    }),

    updateStatus: (id: string, status: string, actor: string, date?: string) =>
        fetchAPI<{ data: any }>(`/transactions/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status, actor, disbursementDate: date })
        }),

    refund: (id: string, refundedAmount: number, refundDate?: string, actor?: string) => fetchAPI<{ data: any }>(`/transactions/${id}/refund`, {
        method: 'POST',
        body: JSON.stringify({ refundedAmount, refundDate, actor })
    }),

    withdraw: (id: string, amount: number, withdrawDate?: string, actor?: string) =>
        fetchAPI<{ data: any }>(`/transactions/${id}/withdraw`, {
            method: 'POST',
            body: JSON.stringify({ amount, withdrawDate, actor })
        }),

    supplement: (id: string, amount: number, supplementDate?: string, note?: string, actor?: string) =>
        fetchAPI<{ data: any }>(`/transactions/${id}/supplement`, {
            method: 'POST',
            body: JSON.stringify({ amount, supplementDate, note, actor })
        }),

    getQR: (id: string) => fetchAPI<{ qrDataUrl: string; url: string }>(`/transactions/${id}/qr?format=json`),

    getConfirmInfo: (token: string) => fetchAPI<{ data: any }>(`/transactions/confirm/${token}`),

    confirm: (token: string, confirmedBy: string) => fetchAPI<{ data: any }>(`/transactions/confirm/${token}`, {
        method: 'POST',
        body: JSON.stringify({ confirmedBy })
    })
};

// ============ BANK ============
export const bankAPI = {
    getBalance: () => fetchAPI<{ data: any }>('/bank/balance'),

    listTransactions: (page?: number) => {
        const query = page ? `?page=${page}` : '';
        return fetchAPI<{ data: any[]; pagination: any }>(`/bank/transactions${query}`);
    },

    addTransaction: (tx: { type: string; amount: number; note?: string; date?: string; projectId?: string }) =>
        fetchAPI<{ data: any }>('/bank/transactions', {
            method: 'POST',
            body: JSON.stringify(tx)
        }),

    adjustOpening: (amount: number) => fetchAPI('/bank/adjust-opening', {
        method: 'POST',
        body: JSON.stringify({ openingBalance: amount })
    }),

    calculateInterest: () => fetchAPI<{ data: any }>('/bank/calculate-interest'),

    capitalizeInterest: (month: number, year: number) =>
        fetchAPI<{ data: any }>('/bank/calculate-interest', {
            method: 'POST',
            body: JSON.stringify({ month, year })
        }),

    accrueInterest: () => fetchAPI<{ data: any }>('/bank/accrue-interest', { method: 'POST' })
};

// ============ USERS ============
export const usersAPI = {
    list: () => fetchAPI<{ data: any[] }>('/users'),

    get: (id: string) => fetchAPI<{ data: any }>(`/users/${id}`),

    create: (user: any) => fetchAPI<{ data: any }>('/users', {
        method: 'POST',
        body: JSON.stringify(user)
    }),

    update: (id: string, user: any) => fetchAPI<{ data: any }>(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(user)
    }),

    delete: (id: string) => fetchAPI(`/users/${id}`, { method: 'DELETE' })
};

// ============ SETTINGS ============
export const settingsAPI = {
    getInterestRate: () => fetchAPI<{ data: any }>('/settings/interest-rate'),

    updateInterestRate: (rate: number, actor: string) =>
        fetchAPI<{ data: any }>('/settings/interest-rate', {
            method: 'PUT',
            body: JSON.stringify({ interestRate: rate, actor })
        }),

    updateBankInterestRate: (rate: number, actor: string) =>
        fetchAPI<{ data: any }>('/settings/bank-interest-rate', {
            method: 'PUT',
            body: JSON.stringify({ bankInterestRate: rate, actor })
        }),

    updateRateChangeSettings: (settings: {
        interestRateChangeDate?: string | null;
        interestRateBefore?: number | null;
        interestRateAfter?: number | null;
    }) =>
        fetchAPI<{ data: any }>('/settings/interest-rate', {
            method: 'PUT',
            body: JSON.stringify(settings)
        })
};

// ============ AUDIT LOGS ============
export const auditAPI = {
    list: (params?: { action?: string; actor?: string; page?: number }) => {
        const query = new URLSearchParams();
        if (params?.action) query.set('action', params.action);
        if (params?.actor) query.set('actor', params.actor);
        if (params?.page) query.set('page', params.page.toString());

        return fetchAPI<{ data: any[]; pagination: any }>(`/audit-logs?${query}`);
    }
};

// ============ ADMIN ============
export const adminAPI = {
    resetData: () => fetchAPI<{ success: boolean; message: string; data: any }>('/admin/reset', {
        method: 'POST'
    })
};

// ============ POLLING ============
export const pollAPI = {
    poll: (since?: string, types?: string) => {
        const query = new URLSearchParams();
        if (since) query.set('since', since);
        if (types) query.set('types', types);

        return fetchAPI<{ hasChanges: boolean; data: any }>(`/events/poll?${query}`);
    }
};

// Export all
export const api = {
    auth: authAPI,
    projects: projectsAPI,
    transactions: transactionsAPI,
    bank: bankAPI,
    users: usersAPI,
    settings: settingsAPI,
    audit: auditAPI,
    admin: adminAPI,
    poll: pollAPI
};

export default api;
