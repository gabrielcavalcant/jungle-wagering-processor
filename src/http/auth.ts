import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ProviderForbiddenError } from '../application/errors';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../application/ports';

/**
 * Authentication is intentionally not implemented (challenge §2 — no points, timeboxed).
 * This adapter is the extension point: an OIDC implementation would validate the bearer JWT
 * issued by Keycloak/Zitadel (client-credentials flow, one client per provider) against the
 * IdP's JWKS and return the `provider_id` claim. See ARCHITECTURE.md §Authentication.
 */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<string | undefined> {
    return undefined;
  }
}

/**
 * Binds the authenticated identity to the payload: when the port returns a providerId,
 * a request claiming another provider is refused (403). With the no-op port it lets everything through.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; body?: { providerId?: unknown }; params?: { providerId?: string } }>();
    const authenticated = await this.identity.resolve(req);
    if (authenticated === undefined) return true;
    const claimed = String(req.body?.providerId ?? req.params?.providerId ?? authenticated);
    if (claimed !== authenticated) throw new ProviderForbiddenError(authenticated, claimed);
    return true;
  }
}
