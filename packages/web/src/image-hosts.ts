import { normalizeImageHostSuffixes } from '@turnkeyai/involute-shared';

let extras: string[] = [];

/** CDN hosts this deployment added, from serverBuild. Built-in cloud hosts do not need it. */
export function extraImageHosts(): readonly string[] {
  return extras;
}

export function setExtraImageHosts(values: readonly string[] | string | null | undefined): void {
  extras = normalizeImageHostSuffixes(values);
}
