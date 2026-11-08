import { useEffect } from 'react';
import { useQuery } from '@apollo/client/react';

import { SERVER_BUILD_QUERY } from '../board/queries';
import type { ServerBuildQueryData } from '../board/types';
import { setExtraImageHosts } from '../image-hosts';

/** Loads this deployment's extra image hosts once a person is signed in. */
export function ImageHostConfig() {
  const { data } = useQuery<ServerBuildQueryData>(SERVER_BUILD_QUERY);
  const suffixes = data?.serverBuild?.imageHostSuffixes;
  useEffect(() => {
    if (suffixes) setExtraImageHosts(suffixes);
  }, [suffixes]);
  return null;
}
