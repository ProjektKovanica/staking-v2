import { Address, Cell, Dictionary, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Dividers, Gas } from '../wrappers/imports/constants';
import { LockPeriodsValue, StakingPool, StakingPoolConfig } from '../wrappers/StakingPool';
import { JettonMinter } from '../wrappers/JettonMinterDefault';
import { JettonWallet } from '../wrappers/JettonWallet';

/**
 * DEPLOY: Kovanica Vault (on-chain staking) — PRODUKCIJSKA skripta.
 *
 * Za razliku od demo `deployPool.ts` (JVault test tokeni), ovo deploya JEDAN pool
 * za Kovanicu s KVNC-om kao istim jettonom za ulog i nagradu. Ne ide kroz factory
 * (nije potreban za jedan pool; app ne koristi per-period stake-jettone) — pool se
 * deploya izravno, isti tok koji je validiran u tests/kovanicaVault.sim.spec.ts.
 *
 * Parametri (odluka vlasnika 2026-08-02):
 *  - lock periodi 30/60/90/180/360 dana → multiplikatori 1,2/1,5/2/3/5x
 *  - budžet nagrada 10.000.000 KVNC kroz 90 dana — puni se iz 350M pool-a
 *    (KVNC treasury UQA9aQ…OkYn7; isti izvor kao tap i off-chain APY), omeđen na
 *    tih 10M/90d kao izričit staking budžet (ECONOMY.md)
 *  - 0% deposit/unstake komisija, 0% reward komisija (admin = mi)
 *
 * ⚠️ MAINNET, PRAVI KVNC. Prije pokretanja:
 *  1) deploy-wallet (provider.sender) MORA biti wallet iz kojeg šalješ 10M KVNC
 *     — 350M pool / KVNC treasury (UQA9aQ…OkYn7) — i imati ≥ ~2 TON gasa;
 *  2) provjeri KVNC_MASTER dolje;
 *  3) NODE_ENV/mreža moraju biti mainnet; prvo pokreni bez zadnjeg koraka
 *     (SKIP_FUND=1) da vidiš pool adresu, upiši je u STAKING_POOL_ADDRESS, pa
 *     tek onda napuni nagrade.
 *
 * Nakon deploya: adresu poola upiši u backend/.env.production STAKING_POOL_ADDRESS.
 */

// KVNC jetton master — provjeri prije mainneta (CLAUDE.md ključne adrese).
const KVNC_MASTER = Address.parse('EQDKKFRJU5uar87OdtvLb8gynFF1fJj40xyYfhUgvc914I5S');

const DAY = 24 * 60 * 60;
const KVNC = (v: number | bigint) => toNano(v); // KVNC ima 9 decimala

const PERIODS: { seconds: number; mult1000: number }[] = [
  { seconds: 30 * DAY, mult1000: 1200 },
  { seconds: 60 * DAY, mult1000: 1500 },
  { seconds: 90 * DAY, mult1000: 2000 },
  { seconds: 180 * DAY, mult1000: 3000 },
  { seconds: 360 * DAY, mult1000: 5000 },
];

const REWARDS_BUDGET = KVNC(10_000_000);
const DISTRIBUTION_DAYS = 90;
const POOL_ID = 1n;

export async function run(provider: NetworkProvider) {
  const sender = provider.sender();
  const admin = sender.address!;
  const skipFund = process.env.SKIP_FUND === '1';

  const stakingPoolUninitedCode = await compile('StakingPoolUninited');
  const stakingPoolCode = await compile('StakingPool');
  const stakeWalletCode = await compile('StakeWallet');

  const kvnc = provider.open(JettonMinter.createFromAddress(KVNC_MASTER));

  // Pool se deploya izravno; factoryAddress = admin (deploy-wallet) za init.
  const pool = provider.open(StakingPool.createFromConfig({ poolId: POOL_ID, factoryAddress: admin }, stakingPoolUninitedCode));
  console.log('Kovanica Vault pool adresa:', pool.address.toString());

  const lockPeriods: Dictionary<number, LockPeriodsValue> = Dictionary.empty();
  for (const p of PERIODS) {
    lockPeriods.set(p.seconds, {
      curTvl: 0n,
      tvlLimit: KVNC(1_000_000_000),
      rewardMultiplier: p.mult1000,        // × REWARDS_DIVIDER (1000)
      depositCommission: 0,
      unstakeCommission: 0,
      minterAddress: pool.address,          // per-period stake-jetton minter se ne koristi u appu
    });
  }

  if (!(await provider.isContractDeployed(pool.address))) {
    const config: StakingPoolConfig = {
      inited: false,
      poolId: POOL_ID,
      factoryAddress: admin,
      adminAddress: admin,
      creatorAddress: admin,
      stakeWalletCode,
      lockWalletAddress: KVNC_MASTER, // pool otkrije svoj KVNC wallet i postavi inited
      minDeposit: KVNC(1),
      maxDeposit: KVNC(1_000_000_000),
      tvl: 0n,
      tvlWithMultipliers: 0n,
      rewardJettons: Dictionary.empty(),
      lockPeriods,
      whitelist: null,
      unstakeFee: toNano('0.3'),
      collectedCommissions: 0n,
      rewardsCommission: 0n,
    };
    await pool.sendDeploy(sender, toNano('0.15'), config, stakingPoolCode);
    await provider.waitForDeploy(pool.address, 30);
    console.log('pool deployan ✅ (čekam init preko KVNC wallet discovery-ja)');
  } else {
    console.log('pool već postoji, preskačem deploy');
  }

  if (skipFund) {
    console.log('SKIP_FUND=1 — pool deployan, nagrade NISU napunjene.');
    console.log('→ Upiši STAKING_POOL_ADDRESS =', pool.address.toString());
    return;
  }

  // Registriraj reward jetton (poolov KVNC wallet) i napuni 10M kroz 90 dana.
  const poolKvncWallet = provider.open(JettonWallet.createFromAddress(await kvnc.getWalletAddress(pool.address)));
  const rewardList: Dictionary<Address, boolean> = Dictionary.empty();
  rewardList.set(poolKvncWallet.address, false);
  await pool.sendAddRewardJettons(sender, rewardList);
  console.log('reward jetton registriran ✅');

  const now = Math.floor(Date.now() / 1000);
  const myKvncWallet = provider.open(JettonWallet.createFromAddress(await kvnc.getWalletAddress(admin)));
  await myKvncWallet.sendTransfer(
    sender, REWARDS_BUDGET, pool.address, admin, Gas.ADD_REWARDS,
    StakingPool.addRewardsPayload(now, now + DISTRIBUTION_DAYS * DAY),
  );
  console.log(`nagrade poslane ✅ 10.000.000 KVNC / ${DISTRIBUTION_DAYS} dana`);
  console.log('→ Upiši STAKING_POOL_ADDRESS =', pool.address.toString());
}
