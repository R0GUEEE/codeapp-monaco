import type { IWorkbenchConstructionOptions } from "vscode/services";

/**
 * Product identity handed to the VS Code services layer.
 *
 * The workbench services read this the same way VS Code reads `product.json`.
 * The extension gallery block points at Open VSX, which implements the same
 * gallery protocol as the Visual Studio Marketplace and is the only registry
 * that can be legally consumed by a third-party client.
 */
export const productConfiguration: NonNullable<
  IWorkbenchConstructionOptions["productConfiguration"]
> = {
  nameShort: "CodifyOne",
  nameLong: "CodifyOne",
  applicationName: "codifyone",
  dataFolderName: ".codifyone",
  version: "1.0.0",
  commit: "codifyone",
  quality: "stable",
  extensionsGallery: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    publisherUrl: "https://open-vsx.org/vscode/publisher",
    resourceUrlTemplate:
      "https://open-vsx.org/vscode/gallery/{publisher}/{name}/{version}/file/{path}",
    controlUrl: "https://open-vsx.org/vscode/gallery",
    nlsBaseUrl: "https://open-vsx.org/vscode/nls",
  },
};
