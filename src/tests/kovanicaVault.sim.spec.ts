import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, Dictionary, beginCell, toNano } from '@ton/core';
import { LockPeriodsValue, StakingPool, StakingPoolConfig } from '../wrappers/StakingPool';
import { StakeWallet } from '../wrappers/StakeWallet';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { JettonMinter as JettonMinterDefault } from '../wrappers/JettonMinterDefault';
import { JettonWallet } from '../wrappers/JettonWallet';
import { AddrList, Dividers, Gas } from '../wrappers/imports/constants';

/**
 * KOVANICA VAULT — ekonomska simulacija (bez testneta/mainneta).
 *
 * Dokazuje da KONKRETNA Kovanica konfiguracija radi u TVM emulatoru:
 *  - lock jetton == reward jetton == KVNC (stakeaš KVNC, zarađuješ KVNC) — realna
 *    Kovanica postavka, glavni rizik koji treba provjeriti;
 *  - budžet nagrada 10.000.000 KVNC kroz 90 dana (odluka vlasnika 2026-08-02);
 *  - lock periodi 30/60/90/180/360 dana → multiplikatori 1,2/1,5/2/3/5x;
 *  - tok: deploy → registriraj+napuni nagrade → stake → protok vremena → claim →
 *    unstake. Provjerava da claim ≈ udio distribucije i da se glavnica vrati.
 *
 * Ovo NIJE zamjena za audit ni za testnet — sam ugovor je nepromijenjen (audit
 * vrijedi), a factory deploy put je pokriven u poolFactory.spec.ts. Ovdje se
 * dokazuju BROJKE s KVNC-om kao istim jettonom za lock i nagradu.
 */
const DAY = 24 * 60 * 60;
const KVNC = (v: number | bigint) => toNano(v); // KVNC ima 9 decimala kao TON

// Kovanica lock periodi (sekunde) → multiplikatori (× REWARDS_DIVIDER=1000).
const PERIODS: { seconds: number; mult1000: number }[] = [
  { seconds: 30 * DAY, mult1000: 1200 },
  { seconds: 60 * DAY, mult1000: 1500 },
  { seconds: 90 * DAY, mult1000: 2000 },
  { seconds: 180 * DAY, mult1000: 3000 },
  { seconds: 360 * DAY, mult1000: 5000 },
];

const REWARDS_BUDGET = KVNC(10_000_000); // 10M KVNC
const DISTRIBUTION_DAYS = 90;

describe('Kovanica Vault simulacija', () => {
  let jettonMinterDefaultCode: Cell;
  let jettonWalletCode: Cell;
  let stakingPoolUninitedCode: Cell;
  let stakingPoolCode: Cell;
  let stakeWalletCode: Cell;

  const now0 = 2_000_000_000;

  let blockchain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;      // pool admin (= mi)
  let creator: SandboxContract<TreasuryContract>;    // pool creator (= mi), puni nagrade
  let user: SandboxContract<TreasuryContract>;

  let kvnc: SandboxContract<JettonMinterDefault>;    // KVNC (lock == reward)
  let pool: SandboxContract<StakingPool>;
  let poolKvncWallet: SandboxContract<JettonWallet>;
  let creatorKvncWallet: SandboxContract<JettonWallet>;
  let userKvncWallet: SandboxContract<JettonWallet>;

  beforeAll(async () => {
    jettonMinterDefaultCode = await compile('JettonMinterDefault');
    jettonWalletCode = await compile('JettonWallet');
    stakingPoolUninitedCode = await compile('StakingPoolUninited');
    stakingPoolCode = await compile('StakingPool');
    stakeWalletCode = await compile('StakeWallet');
  });

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    blockchain.now = now0;

    admin = await blockchain.treasury('kovanicaAdmin');
    creator = await blockchain.treasury('kovanicaCreator');
    user = await blockchain.treasury('staker');

    // KVNC master (jedini jetton — i lock i reward).
    kvnc = blockchain.openContract(JettonMinterDefault.createFromConfig(
      { admin: admin.address, content: Cell.EMPTY, wallet_code: jettonWalletCode },
      jettonMinterDefaultCode,
    ));
    await kvnc.sendMint(admin.getSender(), creator.address, KVNC(20_000_000), toNano('0.2'), toNano('0.5'));
    await kvnc.sendMint(admin.getSender(), user.address, KVNC(1_000_000), toNano('0.2'), toNano('0.5'));

    creatorKvncWallet = blockchain.openContract(JettonWallet.createFromAddress(await kvnc.getWalletAddress(creator.address)));
    userKvncWallet = blockchain.openContract(JettonWallet.createFromAddress(await kvnc.getWalletAddress(user.address)));

    // Pool se deploya izravno (admin je "factory" za init) — factory deploy put je
    // pokriven u poolFactory.spec.ts; ovdje je fokus ekonomika s Kovanica brojkama.
    pool = blockchain.openContract(StakingPool.createFromConfig({ poolId: 1n, factoryAddress: admin.address }, stakingPoolUninitedCode));
    poolKvncWallet = blockchain.openContract(JettonWallet.createFromAddress(await kvnc.getWalletAddress(pool.address)));

    const lockPeriods: Dictionary<number, LockPeriodsValue> = Dictionary.empty();
    for (const p of PERIODS) {
      lockPeriods.set(p.seconds, {
        curTvl: 0n,
        tvlLimit: KVNC(1_000_000_000),
        rewardMultiplier: p.mult1000,                 // već × REWARDS_DIVIDER (1000)
        depositCommission: 0,                          // bez naknade na ulog
        unstakeCommission: 0,                          // bez naknade na izlaz
        minterAddress: pool.address,                   // stake-wallet minter placeholder
      });
    }

    const config: StakingPoolConfig = {
      inited: false,
      poolId: 1n,
      factoryAddress: admin.address,
      adminAddress: admin.address,
      creatorAddress: creator.address,
      stakeWalletCode,
      lockWalletAddress: kvnc.address, // pool traži svoj KVNC wallet i postavi inited
      minDeposit: KVNC(1),
      maxDeposit: KVNC(1_000_000_000),
      tvl: 0n,
      tvlWithMultipliers: 0n,
      rewardJettons: Dictionary.empty(),
      lockPeriods,
      whitelist: null,
      unstakeFee: toNano('0.3'),
      collectedCommissions: 0n,
      rewardsCommission: 0n, // bez komisije na nagrade (admin = mi)
    };

    await pool.sendDeploy(admin.getSender(), toNano('0.05'), config, stakingPoolCode);
    expect((await pool.getStorageData()).inited).toBeTruthy();
    // KVNC je i lock i reward → isti wallet poola.
    expect((await pool.getStorageData()).lockWalletAddress).toEqualAddress(poolKvncWallet.address);
  });

  it('KVNC lock=reward: napuni 10M/90d, stake, claim ≈ udio, unstake vrati glavnicu', async () => {
    // 1) Registriraj reward jetton (poolov KVNC wallet) i napuni 10M kroz 90 dana.
    const rewardList: AddrList = Dictionary.empty();
    rewardList.set(poolKvncWallet.address, false);
    await pool.sendAddRewardJettons(creator.getSender(), rewardList);

    await creatorKvncWallet.sendTransfer(
      creator.getSender(), REWARDS_BUDGET, pool.address, creator.address, Gas.ADD_REWARDS,
      StakingPool.addRewardsPayload(blockchain.now!, blockchain.now! + DISTRIBUTION_DAYS * DAY),
    );
    expect(await poolKvncWallet.getJettonBalance()).toEqual(REWARDS_BUDGET); // 10M u poolu

    // 2) Jedini staker stakea 1.000 KVNC na 90 dana.
    const stakeAmount = KVNC(1_000);
    const period = 90 * DAY;
    const stakeWallet = blockchain.openContract(
      StakeWallet.createFromAddress((await pool.getWalletAddress(user.address, period))!),
    );
    await userKvncWallet.sendTransfer(
      user.getSender(), stakeAmount, pool.address, user.address, Gas.STAKE_JETTONS,
      StakingPool.stakePayload(period),
    );
    expect((await stakeWallet.getStorageData()).jettonBalance).toEqual(stakeAmount); // 0% deposit fee

    // 3) Protok 9 dana (10 % perioda) → jedini staker dobiva ~10 % od 10M = ~1M.
    blockchain.now! += 9 * DAY;

    const before = await userKvncWallet.getJettonBalance();
    await stakeWallet.sendClaimRewards(user.getSender(), rewardList);
    const claimed = (await userKvncWallet.getJettonBalance()) - before;

    const expected = REWARDS_BUDGET * 9n / 90n; // 1.000.000 KVNC
    // tolerancija 1 % (kontinuirana distribucija + zaokruživanja kroz divider)
    const lo = expected * 99n / 100n;
    const hi = expected * 101n / 100n;
    console.log('claimed KVNC:', Number(claimed) / 1e9, ' expected ~', Number(expected) / 1e9);
    expect(claimed).toBeGreaterThan(lo);
    expect(claimed).toBeLessThan(hi);

    // 4) Nakon isteka 90 dana staker povuče glavnicu (unstake, bez naknade).
    blockchain.now! += 90 * DAY;
    await stakeWallet.sendUnstakeRequest(user.getSender(), stakeAmount);
    await stakeWallet.sendUnstakeJettons(user.getSender(), stakeAmount, false, toNano('0.3'));
    // Glavnica se vratila korisniku (uz eventualno još malo nagrada iz preostalog perioda).
    const finalBal = await userKvncWallet.getJettonBalance();
    expect(finalBal).toBeGreaterThanOrEqual(before + claimed + stakeAmount - KVNC(1));
    console.log('final user KVNC wallet:', Number(finalBal) / 1e9);
  });
});
