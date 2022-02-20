import { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import type { RemoteItem, SUPPORTED_SERVICES_TYPE } from "./baseTypes";
import {
  decryptBase32ToString,
  decryptBase64urlToString,
  encryptStringToBase64url,
  MAGIC_ENCRYPTED_PREFIX_BASE32,
  MAGIC_ENCRYPTED_PREFIX_BASE64URL,
} from "./encrypt";
import type { FileFolderHistoryRecord, InternalDBs } from "./localdb";
import {
  clearDeleteRenameHistoryOfKeyAndVault,
  getSyncMetaMappingByRemoteKeyAndVault,
  upsertSyncMetaMappingDataByVault,
} from "./localdb";
import { isHiddenPath, isVaildText, mkdirpInVault } from "./misc";
import { RemoteClient } from "./remote";

import * as origLog from "loglevel";
const log = origLog.getLogger("rs-default");

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_meta"
  | "getting_local_meta"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "finish";

type DecisionType =
  | "undecided"
  | "unknown"
  | "upload_clearhist"
  | "download_clearhist"
  | "delremote_clearhist"
  | "download"
  | "upload"
  | "clearhist"
  | "mkdirplocal"
  | "skip";

interface FileOrFolderMixedState {
  key: string;
  exist_local?: boolean;
  exist_remote?: boolean;
  mtime_local?: number;
  mtime_remote?: number;
  delete_time_local?: number;
  size_local?: number;
  size_remote?: number;
  decision?: DecisionType;
  syncDone?: "done";
  decision_branch?: number;
  remote_encrypted_key?: string;
}

export interface SyncPlanType {
  ts: number;
  remoteType: SUPPORTED_SERVICES_TYPE;
  mixedStates: Record<string, FileOrFolderMixedState>;
}

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "ok"
    | "empty_remote"
    | "remote_encrypted_local_no_password"
    | "password_matched"
    | "password_not_matched"
    | "invalid_text_after_decryption"
    | "remote_not_encrypted_local_has_password"
    | "no_password_both_sides";
}

export const isPasswordOk = async (
  remote: RemoteItem[],
  password: string = ""
) => {
  if (remote === undefined || remote.length === 0) {
    // remote empty
    return {
      ok: true,
      reason: "empty_remote",
    } as PasswordCheckType;
  }
  const santyCheckKey = remote[0].key;
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
    // this is encrypted using old base32!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      } as PasswordCheckType;
    }
    try {
      const res = await decryptBase32ToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        } as PasswordCheckType;
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        } as PasswordCheckType;
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      } as PasswordCheckType;
    }
  }
  if (santyCheckKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)) {
    // this is encrypted using new base64url!
    // try to decrypt it using the provided password.
    if (password === "") {
      return {
        ok: false,
        reason: "remote_encrypted_local_no_password",
      } as PasswordCheckType;
    }
    try {
      const res = await decryptBase64urlToString(santyCheckKey, password);

      // additional test
      // because iOS Safari bypasses decryption with wrong password!
      if (isVaildText(res)) {
        return {
          ok: true,
          reason: "password_matched",
        } as PasswordCheckType;
      } else {
        return {
          ok: false,
          reason: "invalid_text_after_decryption",
        } as PasswordCheckType;
      }
    } catch (error) {
      return {
        ok: false,
        reason: "password_not_matched",
      } as PasswordCheckType;
    }
  } else {
    // it is not encrypted!
    if (password !== "") {
      return {
        ok: false,
        reason: "remote_not_encrypted_local_has_password",
      } as PasswordCheckType;
    }
    return {
      ok: true,
      reason: "no_password_both_sides",
    } as PasswordCheckType;
  }
};

const ensembleMixedStates = async (
  remote: RemoteItem[],
  local: TAbstractFile[],
  deleteHistory: FileFolderHistoryRecord[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE,
  password: string = ""
) => {
  const results = {} as Record<string, FileOrFolderMixedState>;

  if (remote !== undefined) {
    for (const entry of remote) {
      const remoteEncryptedKey = entry.key;
      let key = remoteEncryptedKey;
      if (password !== "") {
        if (remoteEncryptedKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE32)) {
          key = await decryptBase32ToString(remoteEncryptedKey, password);
        } else if (
          remoteEncryptedKey.startsWith(MAGIC_ENCRYPTED_PREFIX_BASE64URL)
        ) {
          key = await decryptBase64urlToString(remoteEncryptedKey, password);
        } else {
          throw Error(`unexpected key=${remoteEncryptedKey}`);
        }
      }
      const backwardMapping = await getSyncMetaMappingByRemoteKeyAndVault(
        remoteType,
        db,
        key,
        entry.lastModified,
        entry.etag,
        vaultRandomID
      );

      let r = {} as FileOrFolderMixedState;
      if (backwardMapping !== undefined) {
        key = backwardMapping.localKey;
        r = {
          key: key,
          exist_remote: true,
          mtime_remote: backwardMapping.localMtime || entry.lastModified,
          size_remote: backwardMapping.localSize || entry.size,
          remote_encrypted_key: remoteEncryptedKey,
        };
      } else {
        r = {
          key: key,
          exist_remote: true,
          mtime_remote: entry.lastModified,
          size_remote: entry.size,
          remote_encrypted_key: remoteEncryptedKey,
        };
      }
      if (isHiddenPath(key)) {
        continue;
      }
      if (results.hasOwnProperty(key)) {
        results[key].key = r.key;
        results[key].exist_remote = r.exist_remote;
        results[key].mtime_remote = r.mtime_remote;
        results[key].size_remote = r.size_remote;
        results[key].remote_encrypted_key = r.remote_encrypted_key;
      } else {
        results[key] = r;
      }
    }
  }

  for (const entry of local) {
    let r = {} as FileOrFolderMixedState;
    let key = entry.path;

    if (entry.path === "/") {
      // ignore
      continue;
    } else if (entry instanceof TFile) {
      r = {
        key: entry.path,
        exist_local: true,
        mtime_local: entry.stat.mtime,
        size_local: entry.stat.size,
      };
    } else if (entry instanceof TFolder) {
      key = `${entry.path}/`;
      r = {
        key: key,
        exist_local: true,
        mtime_local: undefined,
        size_local: 0,
      };
    } else {
      throw Error(`unexpected ${entry}`);
    }

    if (isHiddenPath(key)) {
      continue;
    }
    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].exist_local = r.exist_local;
      results[key].mtime_local = r.mtime_local;
      results[key].size_local = r.size_local;
    } else {
      results[key] = r;
    }
  }

  for (const entry of deleteHistory) {
    let key = entry.key;
    if (entry.keyType === "folder") {
      if (!entry.key.endsWith("/")) {
        key = `${entry.key}/`;
      }
    } else if (entry.keyType === "file") {
      // pass
    } else {
      throw Error(`unexpected ${entry}`);
    }

    const r = {
      key: key,
      delete_time_local: entry.actionWhen,
    } as FileOrFolderMixedState;

    if (isHiddenPath(key)) {
      continue;
    }
    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].delete_time_local = r.delete_time_local;
    } else {
      results[key] = r;
    }
  }

  return results;
};

const getOperation = (
  origRecord: FileOrFolderMixedState,
  inplace: boolean = false,
  password: string = ""
) => {
  let r = origRecord;
  if (!inplace) {
    r = Object.assign({}, origRecord);
  }

  if (r.mtime_local === 0) {
    r.mtime_local = undefined;
  }
  if (r.mtime_remote === 0) {
    r.mtime_remote = undefined;
  }
  if (r.delete_time_local === 0) {
    r.delete_time_local = undefined;
  }
  if (r.exist_local === undefined) {
    r.exist_local = false;
  }
  if (r.exist_remote === undefined) {
    r.exist_remote = false;
  }
  r.decision = "unknown";

  if (
    r.exist_remote &&
    r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local !== undefined &&
    r.mtime_remote > r.mtime_local
  ) {
    r.decision = "download_clearhist";
    r.decision_branch = 1;
  } else if (
    r.exist_remote &&
    r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local !== undefined &&
    r.mtime_remote < r.mtime_local
  ) {
    r.decision = "upload_clearhist";
    r.decision_branch = 2;
  } else if (
    r.exist_remote &&
    r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local !== undefined &&
    r.mtime_remote === r.mtime_local &&
    password === "" &&
    r.size_local === r.size_remote
  ) {
    r.decision = "skip";
    r.decision_branch = 3;
  } else if (
    r.exist_remote &&
    r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local !== undefined &&
    r.mtime_remote === r.mtime_local &&
    password === "" &&
    r.size_local !== r.size_remote
  ) {
    r.decision = "upload_clearhist";
    r.decision_branch = 4;
  } else if (
    r.exist_remote &&
    r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local !== undefined &&
    r.mtime_remote === r.mtime_local &&
    password !== ""
  ) {
    // if we have encryption,
    // the size is always unequal
    // only mtime(s) are reliable
    r.decision = "skip";
    r.decision_branch = 5;
  } else if (r.exist_remote && r.exist_local && r.mtime_local === undefined) {
    // this must be a folder!
    if (!r.key.endsWith("/")) {
      throw Error(`${r.key} is not a folder but lacks local mtime`);
    }
    r.decision = "skip";
    r.decision_branch = 6;
  } else if (
    r.exist_remote &&
    !r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local === undefined &&
    r.delete_time_local !== undefined &&
    r.mtime_remote >= r.delete_time_local
  ) {
    r.decision = "download_clearhist";
    r.decision_branch = 7;
  } else if (
    r.exist_remote &&
    !r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local === undefined &&
    r.delete_time_local !== undefined &&
    r.mtime_remote < r.delete_time_local
  ) {
    r.decision = "delremote_clearhist";
    r.decision_branch = 8;
  } else if (
    r.exist_remote &&
    !r.exist_local &&
    r.mtime_remote !== undefined &&
    r.mtime_local === undefined &&
    r.delete_time_local == undefined
  ) {
    r.decision = "download";
    r.decision_branch = 9;
  } else if (!r.exist_remote && r.exist_local && r.mtime_remote === undefined) {
    r.decision = "upload_clearhist";
    r.decision_branch = 10;
  } else if (
    !r.exist_remote &&
    !r.exist_local &&
    r.mtime_remote === undefined &&
    r.mtime_local === undefined
  ) {
    r.decision = "clearhist";
    r.decision_branch = 11;
  }

  if (r.decision === "unknown") {
    throw Error(`unknown decision for ${JSON.stringify(r)}`);
  }

  return r;
};

export const getSyncPlan = async (
  remote: RemoteItem[],
  local: TAbstractFile[],
  deleteHistory: FileFolderHistoryRecord[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE,
  password: string = ""
) => {
  const mixedStates = await ensembleMixedStates(
    remote,
    local,
    deleteHistory,
    db,
    vaultRandomID,
    remoteType,
    password
  );
  for (const [key, val] of Object.entries(mixedStates)) {
    getOperation(val, true, password);
  }
  const plan = {
    ts: Date.now(),
    remoteType: remoteType,
    mixedStates: mixedStates,
  } as SyncPlanType;
  return plan;
};

const dispatchOperationToActual = async (
  key: string,
  vaultRandomID: string,
  state: FileOrFolderMixedState,
  client: RemoteClient,
  db: InternalDBs,
  vault: Vault,
  password: string = "",
  foldersCreatedBefore: Set<string> | undefined = undefined
) => {
  let remoteEncryptedKey = key;
  if (password !== "") {
    remoteEncryptedKey = state.remote_encrypted_key;
    if (remoteEncryptedKey === undefined || remoteEncryptedKey === "") {
      // the old version uses base32
      // remoteEncryptedKey = await encryptStringToBase32(key, password);
      // the new version users base64url
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  if (
    state.decision === undefined ||
    state.decision === "unknown" ||
    state.decision === "undecided"
  ) {
    throw Error(`unknown decision in ${JSON.stringify(state)}`);
  } else if (state.decision === "skip") {
    // do nothing
  } else if (
    client.serviceType === "onedrive" &&
    state.size_local === 0 &&
    !state.key.endsWith("/") &&
    password === "" &&
    (state.decision === "upload" || state.decision === "upload_clearhist")
  ) {
    // TODO: it's ugly, any other way to deal with empty file for onedrive?
    // do nothing, skip empty file without encryption
    // if it's empty folder, or it's encrypted file/folder, it continues to be uploaded.
    // this branch should be earlier than normal upload / upload_clearhist branches.
    log.debug(`skip empty file ${state.key} uploading for OneDrive`);
  } else if (state.decision === "download_clearhist") {
    await client.downloadFromRemote(
      state.key,
      vault,
      state.mtime_remote,
      password,
      remoteEncryptedKey
    );
    await clearDeleteRenameHistoryOfKeyAndVault(db, state.key, vaultRandomID);
  } else if (state.decision === "upload_clearhist") {
    const remoteObjMeta = await client.uploadToRemote(
      state.key,
      vault,
      false,
      password,
      remoteEncryptedKey,
      foldersCreatedBefore
    );
    await upsertSyncMetaMappingDataByVault(
      client.serviceType,
      db,
      state.key,
      state.mtime_local,
      state.size_local,
      state.key,
      remoteObjMeta.lastModified,
      remoteObjMeta.size,
      remoteObjMeta.etag,
      vaultRandomID
    );
    await clearDeleteRenameHistoryOfKeyAndVault(db, state.key, vaultRandomID);
  } else if (state.decision === "download") {
    await mkdirpInVault(state.key, vault);
    await client.downloadFromRemote(
      state.key,
      vault,
      state.mtime_remote,
      password,
      remoteEncryptedKey
    );
  } else if (state.decision === "delremote_clearhist") {
    await client.deleteFromRemote(state.key, password, remoteEncryptedKey);
    await clearDeleteRenameHistoryOfKeyAndVault(db, state.key, vaultRandomID);
  } else if (state.decision === "upload") {
    const remoteObjMeta = await client.uploadToRemote(
      state.key,
      vault,
      false,
      password,
      remoteEncryptedKey,
      foldersCreatedBefore
    );
    await upsertSyncMetaMappingDataByVault(
      client.serviceType,
      db,
      state.key,
      state.mtime_local,
      state.size_local,
      state.key,
      remoteObjMeta.lastModified,
      remoteObjMeta.size,
      remoteObjMeta.etag,
      vaultRandomID
    );
  } else if (state.decision === "clearhist") {
    await clearDeleteRenameHistoryOfKeyAndVault(db, state.key, vaultRandomID);
  } else {
    throw Error("this should never happen!");
  }
};

export const doActualSync = async (
  client: RemoteClient,
  db: InternalDBs,
  vaultRandomID: string,
  vault: Vault,
  syncPlan: SyncPlanType,
  password: string = "",
  callbackSyncProcess?: any
) => {
  const keyStates = syncPlan.mixedStates;
  const foldersCreatedBefore = new Set<string>();
  let i = 0;
  const totalCount = Object.keys(keyStates).length || 0;
  for (const [k, v] of Object.entries(keyStates).sort(
    ([k1, v1], [k2, v2]) => k2.length - k1.length
  )) {
    i += 1;
    const k2 = k as string;
    const v2 = v as FileOrFolderMixedState;
    log.debug(`start syncing "${k2}" with plan ${JSON.stringify(v2)}`);
    if (callbackSyncProcess !== undefined) {
      await callbackSyncProcess(i, totalCount, k2, v2.decision);
    }
    await dispatchOperationToActual(
      k2,
      vaultRandomID,
      v2,
      client,
      db,
      vault,
      password,
      foldersCreatedBefore
    );
    log.info(`finished ${k2}`);
  }
  // await Promise.all(
  //   Object.entries(keyStates)
  //     .map(async ([k, v]) =>
  //       dispatchOperationToActual(
  //         k as string,
  //         v as FileOrFolderMixedState,
  //         client,
  //         db,
  //         vault,
  //         password,
  //         foldersCreatedBefore
  //       )
  //     )
  // );
};
