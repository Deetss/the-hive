/**
 * Shared shape for the human artifact-review queue. Agents drop a descriptor
 * JSON into <hive>/artifacts/; the Review panel lists the pending ones and the
 * reviewer approves/rejects each, which writes the decision back to the
 * originating agent's inbox. See hive/artifacts/README.md for the on-disk
 * contract this type mirrors.
 */

export type ArtifactType = 'image' | 'plan' | 'doc' | 'design';
export type ArtifactStatus = 'pending' | 'approved' | 'rejected';

export interface ArtifactDescriptor {
  id: string;
  type: ArtifactType;
  title: string;
  description: string;
  /** Absolute path to the artifact file on disk. */
  filePath: string;
  agentId: string;
  agentName?: string;
  /** ISO 8601. */
  createdAt: string;
  status: ArtifactStatus;
  note?: string;
}

export const ARTIFACT_TYPES: readonly ArtifactType[] = ['image', 'plan', 'doc', 'design'];
