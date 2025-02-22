import {
  TokenAccount,
  cancelBid,
  cache,
  ensureWrappedAccount,
  sendTransactionWithRetry,
  AuctionState,
  ParsedAccount,
  BidderMetadata,
  StringPublicKey,
  WalletSigner,
  toPublicKey,
} from '@oyster/common';
import { AccountLayout } from '@solana/spl-token';
import { TransactionInstruction, Keypair, Connection } from '@solana/web3.js';
import { AuctionView } from '../hooks';
import {
  BidRedemptionTicket,
  PrizeTrackingTicket,
} from '@oyster/common/dist/lib/models/metaplex/index';
import { claimUnusedPrizes } from './claimUnusedPrizes';
import { setupPlaceBid } from './sendPlaceBid';
import { WalletNotConnectedError } from '@solana/wallet-adapter-base';
import { SmartInstructionSender } from '@holaplex/solana-web3-tools';

export async function sendCancelBidOrReclaimItems(
  connection: Connection,
  wallet: WalletSigner,
  payingAccount: StringPublicKey,
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  bids: ParsedAccount<BidderMetadata>[],
  bidRedemptions: Record<string, ParsedAccount<BidRedemptionTicket>>,
  prizeTrackingTickets: Record<string, ParsedAccount<PrizeTrackingTicket>>,
) {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  const signers: Array<Keypair[]> = [];
  const instructions: Array<TransactionInstruction[]> = [];

  if (
    auctionView.auction.info.ended() &&
    auctionView.auction.info.state !== AuctionState.Ended
  ) {
    await setupPlaceBid(
      connection,
      wallet,
      payingAccount,
      auctionView,
      accountsByMint,
      0,
      instructions,
      signers,
    );
  }

  const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );

  await setupCancelBid(
    auctionView,
    accountsByMint,
    accountRentExempt,
    wallet,
    signers,
    instructions,
  );

  if (
    wallet.publicKey.equals(
      toPublicKey(auctionView.auctionManager.authority), // isAuctioneer
    ) &&
    auctionView.auction.info.ended()
  ) {
    await claimUnusedPrizes(
      connection,
      wallet,
      auctionView,
      accountsByMint,
      bids,
      bidRedemptions,
      prizeTrackingTickets,
      signers,
      instructions,
    );
  }

  if (instructions.length === 1) {
    await sendTransactionWithRetry(
      connection,
      wallet,
      instructions[0],
      signers[0],
      'single',
    );
  } else {
    let cancelBidError: Error | null = null;

    await SmartInstructionSender.build(wallet as any, connection)
      .config({
        abortOnFailure: true,
        maxSigningAttempts: 3,
        commitment: 'single',
      })
      .withInstructionSets(
        instructions.map((ixs, i) => ({
          instructions: ixs,
          signers: signers[i],
        })),
      )
      .onFailure(err => {
        cancelBidError = err;
      })
      .send();

    if (cancelBidError) {
      throw cancelBidError;
    }
  }
}

export async function setupCancelBid(
  auctionView: AuctionView,
  accountsByMint: Map<string, TokenAccount>,
  accountRentExempt: number,
  wallet: WalletSigner,
  signers: Array<Keypair[]>,
  instructions: Array<TransactionInstruction[]>,
) {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  const cancelSigners: Keypair[] = [];
  const cancelInstructions: TransactionInstruction[] = [];
  const cleanupInstructions: TransactionInstruction[] = [];

  const tokenAccount = accountsByMint.get(auctionView.auction.info.tokenMint);
  const mint = cache.get(auctionView.auction.info.tokenMint);

  if (mint && auctionView.myBidderPot) {
    const receivingSolAccount = ensureWrappedAccount(
      cancelInstructions,
      cleanupInstructions,
      tokenAccount,
      wallet.publicKey,
      accountRentExempt,
      cancelSigners,
    );

    await cancelBid(
      wallet.publicKey.toBase58(),
      receivingSolAccount,
      auctionView.myBidderPot.info.bidderPot,
      auctionView.auction.info.tokenMint,
      auctionView.vault.pubkey,
      cancelInstructions,
    );
    signers.push(cancelSigners);
    instructions.push([
      ...cancelInstructions,
      ...cleanupInstructions.reverse(),
    ]);
  }
}
