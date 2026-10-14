/** Generated from the versioned catalog. Do not edit directly. */
import type { BuiltinInput, BuiltinOutput } from './operation-types.js';
export const builtinReferences = {
  googleWorkspace: {
    command: "google-workspace.command",
  },
  openRouter: {
    audioTranscribe: "openrouter.audio.transcribe",
    chatGenerate: "openrouter.chat.generate",
    imagesGenerate: "openrouter.images.generate",
    imagesModelEndpointsList: "openrouter.images.model_endpoints.list",
    imagesModelsList: "openrouter.images.models.list",
    modelsList: "openrouter.models.list",
    videosModelsList: "openrouter.videos.models.list",
  },
  recraft: {
    imagesRemoveBackground: "recraft.images.remove_background",
  },
  jovitaHosting: {
    browserAudit: "jovita.hosting.browser.audit",
    domainAttach: "jovita.hosting.domain.attach",
    domainRemove: "jovita.hosting.domain.remove",
    domainStatus: "jovita.hosting.domain.status",
    formUpsert: "jovita.hosting.form.upsert",
    previewCreate: "jovita.hosting.preview.create",
    previewDelete: "jovita.hosting.preview.delete",
    previewFinalize: "jovita.hosting.preview.finalize",
    releaseAbort: "jovita.hosting.release.abort",
    releaseCreate: "jovita.hosting.release.create",
    releaseFinalize: "jovita.hosting.release.finalize",
    releaseHealth: "jovita.hosting.release.health",
    releaseList: "jovita.hosting.release.list",
    releaseLookup: "jovita.hosting.release.lookup",
    releasePromote: "jovita.hosting.release.promote",
    releaseRollback: "jovita.hosting.release.rollback",
    siteLookup: "jovita.hosting.site.lookup",
    siteReserve: "jovita.hosting.site.reserve",
    submissionExport: "jovita.hosting.submission.export",
    submissionList: "jovita.hosting.submission.list",
    visualSnapshot: "jovita.hosting.visual.snapshot",
  },
  jovitaMedia: {
    cancel: "jovita.media.cancel",
    download: "jovita.media.download",
    persistResult: "jovita.media.persist-result",
    quote: "jovita.media.quote",
    status: "jovita.media.status",
    submit: "jovita.media.submit",
    voices: "jovita.media.voices",
  },
  voiceLibrary: {
    delete: "jovita.voice-library.delete",
    list: "jovita.voice-library.list",
    rename: "jovita.voice-library.rename",
    save: "jovita.voice-library.save",
    show: "jovita.voice-library.show",
  },
  cloudflare: {
    captureProduct: "cloudflare.browser.capture_product.v1",
  },
} as const;

export type BuiltinReferences = typeof builtinReferences;
export type BuiltinProviderClient = {
  [P in keyof BuiltinReferences]: {
    [M in keyof BuiltinReferences[P]]: (input: BuiltinInput<BuiltinReferences[P][M] & string>) => Promise<BuiltinOutput<BuiltinReferences[P][M] & string>>;
  };
};
