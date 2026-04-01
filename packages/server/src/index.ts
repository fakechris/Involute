import 'dotenv/config';

export interface ServerEnvironment {
  databaseUrl: string;
  authToken: string;
  port: number;
}

export function getServerEnvironment(env: NodeJS.ProcessEnv = process.env): ServerEnvironment {
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    authToken: env.AUTH_TOKEN ?? '',
    port: Number(env.PORT ?? '4200'),
  };
}
