import { gql } from '@apollo/client';

// Connecting and disconnecting the Involute Capture extension (INV-1145).
export const EXTENSION_TOKENS_QUERY = gql`
  query ExtensionTokens {
    extensionTokens {
      id
      name
      createdAt
      expiresAt
      revokedAt
      lastUsedAt
    }
  }
`;

export const EXTENSION_TOKEN_CREATE_MUTATION = gql`
  mutation ExtensionTokenCreate($name: String) {
    extensionTokenCreate(name: $name) {
      success
      message
      token
      extensionToken {
        id
        name
        expiresAt
      }
    }
  }
`;

export const EXTENSION_TOKEN_REVOKE_MUTATION = gql`
  mutation ExtensionTokenRevoke($id: String!) {
    extensionTokenRevoke(id: $id) {
      success
      message
      extensionToken {
        id
        revokedAt
      }
    }
  }
`;

export interface ExtensionTokenRow {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}
