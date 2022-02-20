const DEFAULT_README_FOR_METADATAONREMOTE =
  "Do NOT edit or delete the file manually. This file is for the plugin remotely-save to store some necessary meta data on the remote services.";

const DEFAULT_VERSION_FOR_METADATAONREMOTE = "20220220";

export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE =
  "_remotely-save-metadata-on-remote.json";

export interface DeletionOnRemote {
  key: string;
  actionWhen: number;
}

export interface MetadataOnRemote {
  _readme?: string;
  _version?: string;
  _generatedWhen?: number;
  deletions?: DeletionOnRemote[];
}

export const serializeMetadataOnRemote = (x: MetadataOnRemote) => {
  const y = x;
  if (y["_readme"] === undefined) {
    y["_readme"] = DEFAULT_README_FOR_METADATAONREMOTE;
  }
  if (y["_version"] === undefined) {
    y["_version"] === DEFAULT_VERSION_FOR_METADATAONREMOTE;
  }
  if (y["_generatedWhen"] === undefined) {
    y["_generatedWhen"] = Date.now();
  }
  if (y["deletions"] === undefined) {
    y["deletions"] = [];
  }
  return JSON.stringify(x, null, 2);
};

export const deserializeMetadataOnRemote = (x: string) => {
  const y1: any = JSON.parse(x);
  // TODO: any validations?
  const y2 = y1 as MetadataOnRemote;
  if (y2["deletions"] === undefined) {
    y2["deletions"] = [];
  }
  return y2;
};
