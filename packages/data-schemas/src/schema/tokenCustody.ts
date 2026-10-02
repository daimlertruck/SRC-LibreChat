import { Schema } from 'mongoose';
import type { ITokenCustody } from '~/types';

const tokenCustodySchema: Schema<ITokenCustody> = new Schema<ITokenCustody>({
  tokenKeyHash: {
    type: String,
    required: true,
  },
  sealedTokens: {
    type: String,
    required: true,
  },
  userId: {
    type: String,
    required: true,
  },
  tenantId: {
    type: String,
  },
  openidIssuer: {
    type: String,
  },
  openidSubject: {
    type: String,
  },
  rotationCounter: {
    type: Number,
    required: true,
  },
  accessTokenExpiresAt: {
    type: Number,
  },
  refreshTokenExpiresAt: {
    type: Number,
  },
  lastRefreshedAt: {
    type: Number,
    required: true,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

tokenCustodySchema.index({ tokenKeyHash: 1 }, { unique: true });
tokenCustodySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tokenCustodySchema.index({ userId: 1, tenantId: 1 });

export default tokenCustodySchema;
