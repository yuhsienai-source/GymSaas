const RESET_TICKET_KEY = 'gymsaas_device_reset_ticket';
const RESET_EMAIL_KEY = 'gymsaas_device_reset_email';

export function stashDeviceResetSession(opts: {
  resetTicket: string;
  maskedEmail?: string;
}) {
  try {
    sessionStorage.setItem(RESET_TICKET_KEY, opts.resetTicket);
    if (opts.maskedEmail) sessionStorage.setItem(RESET_EMAIL_KEY, opts.maskedEmail);
  } catch {
    /* ignore quota */
  }
}

export function readDeviceResetSession(): {
  resetTicket: string;
  maskedEmail: string;
} | null {
  try {
    const resetTicket = sessionStorage.getItem(RESET_TICKET_KEY) || '';
    if (!resetTicket) return null;
    return {
      resetTicket,
      maskedEmail: sessionStorage.getItem(RESET_EMAIL_KEY) || '',
    };
  } catch {
    return null;
  }
}

export function clearDeviceResetSession() {
  try {
    sessionStorage.removeItem(RESET_TICKET_KEY);
    sessionStorage.removeItem(RESET_EMAIL_KEY);
  } catch {
    /* ignore */
  }
}
