export function normalizeDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    return databaseUrl;
  }

  try {
    const parsedUrl = new URL(databaseUrl);

    if (!parsedUrl.username && !parsedUrl.password) {
      return databaseUrl;
    }

    parsedUrl.username = safeDecode(parsedUrl.username);
    parsedUrl.password = safeDecode(parsedUrl.password);

    return parsedUrl.toString();
  } catch {
    return databaseUrl;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
