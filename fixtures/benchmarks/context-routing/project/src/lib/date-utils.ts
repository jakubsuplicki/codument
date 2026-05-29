const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isDateInIsoWeek(isoDate: string, isoWeek: string): boolean {
  const weekStart = startOfIsoWeek(isoWeek);
  const value = Date.parse(`${isoDate}T12:00:00.000Z`);
  const start = weekStart.getTime();
  const end = start + 7 * MS_PER_DAY;

  return value >= start && value < end;
}

export function startOfIsoWeek(isoWeek: string): Date {
  const [yearPart, weekPart] = isoWeek.split("-W");
  const year = Number(yearPart);
  const week = Number(weekPart);
  const januaryFourth = Date.UTC(year, 0, 4, 12);
  const januaryFourthDay = new Date(januaryFourth).getUTCDay() || 7;
  const firstMonday = januaryFourth - (januaryFourthDay - 1) * MS_PER_DAY;

  return new Date(firstMonday + (week - 1) * 7 * MS_PER_DAY);
}
