// SDK 3.2.1 ships these types but omits them from its ESM exports map.
declare module '@signalwire/compatibility-api' {
  export const RestClient: {
    validateRequest(signingKey: string, signature: string, url: string, params: Record<string, string>): boolean;
  };
}
