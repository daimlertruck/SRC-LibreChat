import { Model } from 'mongoose';
import type * as t from '~/types';
import tokenCustodySchema from '~/schema/tokenCustody';

/**
 * Custody records hold each browser session's sealed OpenID token set, keyed by
 * a hash of the browser-held token key and swept by TTL. Methods apply explicit
 * tenant checks, so automatic tenant isolation would be the wrong boundary here.
 */
export function createTokenCustodyModel(
  mongoose: typeof import('mongoose'),
): Model<t.ITokenCustody> {
  return (
    mongoose.models.TokenCustody ||
    mongoose.model<t.ITokenCustody>('TokenCustody', tokenCustodySchema)
  );
}
