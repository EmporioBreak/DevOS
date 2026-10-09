import { createHash } from "node:crypto";

/** The upstream Spec Kit v1.1.2 bundles reviewed for DevOS 2 S03.
 * Bundles distribute original components. DevOS Runner remains the ONLY task executor.
 */
export const PINNED_SPEC_KIT_REVISION = "959e866caa3618bf3dc290d5dca33394365af9c6";
export const PINNED_ORIGINAL_BUNDLES = {
  bugfix: {
    sha256: "88cef0850501e52291ae7cd30f2a515119777c53dd316ed1849a4dbf819284f0",
    extension: "bug",
    extensionVersion: "1.0.0",
    workflow: "bugfix",
  },
  assess: {
    sha256: "4d7b7c038c34fd65b8226f84b0a8e93c615029e2c5dc3b58f5bda89240919573",
    extension: "assess",
    extensionVersion: "1.0.1",
    workflow: "assess",
  },
} as const;

export type PinnedOriginalBundle = keyof typeof PINNED_ORIGINAL_BUNDLES;
export type OriginalBundleDecision = {
  id: PinnedOriginalBundle;
  extension: string;
  workflow: string;
  manualInstallOnly: true;
  requiresOwnerApproval: true;
  mayStartWorkflowEngine: false;
  mayActivatePresets: false;
  mayCreateGithubIssues: false;
};

/** Validate byte-for-byte upstream provenance before proposing an explicit manual
 * Spec Kit CLI installation. This is not an installer or a permission grant.
 * Callers MUST separately verify the pinned source revision and source cleanliness.
 */
export function inspectOriginalSpecKitBundle(
  id: string,
  manifest: Uint8Array,
): OriginalBundleDecision {
  if (!Object.hasOwn(PINNED_ORIGINAL_BUNDLES, id)) {
    throw new Error("Unknown/non-reviewed Spec Kit bundle; installation is not permitted");
  }
  const known = PINNED_ORIGINAL_BUNDLES[id as PinnedOriginalBundle];
  const digest = createHash("sha256").update(manifest).digest("hex");
  if (digest !== known.sha256) {
    throw new Error("Original Spec Kit bundle manifest SHA-256 mismatch");
  }
  return {
    id: id as PinnedOriginalBundle,
    extension: known.extension,
    workflow: known.workflow,
    manualInstallOnly: true,
    requiresOwnerApproval: true,
    mayStartWorkflowEngine: false,
    mayActivatePresets: false,
    mayCreateGithubIssues: false,
  };
}
