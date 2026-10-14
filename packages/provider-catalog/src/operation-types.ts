/** Reviewed input/output shapes. Operations without a published shape stay JSON objects. */
export type BuiltinTypeOverrides = {
  'cloudflare.browser.capture_product.v1': {
    input: { url: string };
    output: { status: 'blocked'; reason: string } | { status: 'complete'; final_url: string;
      title: string; description: string; visible_text: string; screenshot_base64: string;
      colors: string[]; fonts: string[]; captured_at: string };
  };
};

export type BuiltinInput<R extends string> = R extends keyof BuiltinTypeOverrides
  ? BuiltinTypeOverrides[R]['input'] : Record<string, unknown>;
export type BuiltinOutput<R extends string> = R extends keyof BuiltinTypeOverrides
  ? BuiltinTypeOverrides[R]['output'] : Record<string, unknown>;
