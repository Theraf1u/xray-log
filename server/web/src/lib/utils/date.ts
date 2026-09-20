
import { formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';
import { format as dateFnsFormat } from 'date-fns';

/** date-fns's format(), defaulted to Russian. See formatDistanceToNowRu for why. */
export function formatRu(date: Date | string | number, pattern: string): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return dateFnsFormat(d, pattern, { locale: ru });
}


/**
 * date-fns's formatDistanceToNow, defaulted to Russian with a suffix.
 *
 * date-fns renders in English unless a locale is passed explicitly, so every
 * bare `formatDistanceToNow(date, { addSuffix: true })` in the app was
 * producing "2 minutes ago" on an otherwise Russian page. This wrapper is the
 * one place that decision is made; call sites just pass a date.
 */
export function formatDistanceToNowRu(date: Date | string | number): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true, locale: ru });
}
/**
 * Check if date string is valid (not zero time or year before 2000)
 */
export function isValidDate(dateStr: string | undefined | null): boolean {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return !isNaN(date.getTime()) && date.getFullYear() > 2000;
}

/**
 * Format date as relative time (e.g., "2 minutes ago", "1 hour ago")
 */
// Russian plural forms: 1 минута / 2 минуты / 5 минут. Needed because
// declining a Russian noun by count is not "singular vs. plural" like
// English — it is a three-way split (1, 2-4, 5+, with an exception for
// 11-14 which always take the "5+" form).
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatRelativeTime(dateStr: string | undefined | null): string {
  if (!dateStr || !isValidDate(dateStr)) return 'Никогда';

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Только что';
  if (diffMin < 60) return `${diffMin} ${pluralRu(diffMin, 'минуту', 'минуты', 'минут')} назад`;
  if (diffHour < 24) return `${diffHour} ${pluralRu(diffHour, 'час', 'часа', 'часов')} назад`;
  if (diffDay < 7) return `${diffDay} ${pluralRu(diffDay, 'день', 'дня', 'дней')} назад`;

  return date.toLocaleDateString('ru-RU');
}

/**
 * Format a number with locale-specific separators
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Calculate percentage
 */
export function percentage(value: number, total: number): number {
  if (total === 0) return 0;
  return (value / total) * 100;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
