use anchor_lang::prelude::*;
use anchor_spl::associated_token::{
    self, get_associated_token_address_with_program_id as get_ata, AssociatedToken,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use solana_program::keccak;
use std::mem::size_of;

declare_id!("2Xii6vHBc47isGv7ecXXdzcJbsPbH5rbHTsYuvycByRu");

const SECONDS_PER_YEAR: i64 = 60 * 60 * 24 * 365;

#[program]
pub mod obridge {
    use super::*;

    pub fn initiate(
        ctx: Context<Initiate>,
        _uuid: [u8; 16],
        to: Pubkey,
        amount: u64,
        lock1: Lock,
        lock2: Option<Lock>,
        deadline: i64,
        refund_time: i64,
        _extra_data: Vec<u8>,
    ) -> Result<()> {
        require!(amount > 0, Errors::InvalidAmount);

        let timestamp = Clock::get()?.unix_timestamp;
        require!(timestamp <= deadline, Errors::DeadlineExceeded);

        associated_token::create(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.escrow_ata.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.escrow_ata.to_account_info(),
                    authority: ctx.accounts.from.to_account_info(),
                },
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.token_program = ctx.accounts.token_program.key.clone();
        escrow.escrow_ata = ctx.accounts.escrow_ata.key().clone();
        escrow.source = ctx.accounts.source.key().clone();
        escrow.destination = get_ata(
            &to,
            &ctx.accounts.mint.key(),
            &ctx.accounts.token_program.key,
        );
        escrow.amount = amount;

        let max_timelock = timestamp + SECONDS_PER_YEAR;
        require!(refund_time <= max_timelock, Errors::InvalidTimelock);
        require!(
            lock1.deadline > timestamp && lock1.deadline <= refund_time,
            Errors::InvalidTimelock
        );
        escrow.lock1 = lock1;
        escrow.refund_time = refund_time;

        if lock2.is_some() {
            let lock = lock2.unwrap();
            require!(
                lock.deadline > timestamp && lock.deadline <= refund_time,
                Errors::InvalidTimelock
            );
            escrow.lock2 = Some(lock);
        }

        Ok(())
    }

    pub fn confirm(ctx: Context<Confirm>, uuid: [u8; 16], preimage: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let hash = keccak::hash(&preimage).0;
        let timestamp = Clock::get()?.unix_timestamp;

        let unlock_result = escrow.lock1.check(&hash, timestamp);
        if unlock_result.is_err() {
            if escrow.lock2.is_none() {
                return unlock_result;
            }
            escrow.lock2.clone().unwrap().check(&hash, timestamp)?;
        }

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]],
            ),
            escrow.amount,
        )?;

        escrow.amount = 0;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, uuid: [u8; 16]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let timestamp = Clock::get()?.unix_timestamp;

        require!(timestamp > escrow.refund_time, Errors::NotRefundable);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.source.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]],
            ),
            escrow.amount,
        )?;

        escrow.amount = 0;
        Ok(())
    }
}

#[error_code]
pub enum Errors {
    #[msg("account mismatch")]
    AccountMismatch,
    #[msg("escrow closed")]
    EscrowClosed,
    #[msg("failed to unlock")]
    FailedToUnlock,
    #[msg("invalid amount")]
    InvalidAmount,
    #[msg("invalid timelock")]
    InvalidTimelock,
    #[msg("invalid destination")]
    InvalidDestination,
    #[msg("deadline exceeded")]
    DeadlineExceeded,
    #[msg("preimage mismatch")]
    PreimageMismatch,
    #[msg("not refundable yet")]
    NotRefundable,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Lock {
    pub hash: [u8; 32],
    pub deadline: i64,
}

impl Lock {
    fn check(&self, hash: &[u8; 32], timestamp: i64) -> Result<()> {
        require!(timestamp <= self.deadline, Errors::DeadlineExceeded);
        require!(hash.eq(&self.hash), Errors::PreimageMismatch);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct Initiate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub from: Signer<'info>,

    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    #[account(init, payer = payer, space = size_of::<Escrow>() + 8, seeds = [&uuid], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, address = get_ata(&escrow.to_account_info().key(), &mint.key(), token_program.key))]
    /// CHECK: transfer escrow account
    pub escrow_ata: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct Confirm<'info> {
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = destination @ Errors::AccountMismatch,
        has_one = escrow_ata @ Errors::AccountMismatch,
        has_one = token_program @ Errors::AccountMismatch,
        constraint = escrow.amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 16])]
pub struct Refund<'info> {
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = source @ Errors::AccountMismatch,
        has_one = escrow_ata @ Errors::AccountMismatch,
        has_one = token_program @ Errors::AccountMismatch,
        constraint = escrow.amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Escrow {
    pub token_program: Pubkey,
    pub escrow_ata: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub lock1: Lock,
    pub lock2: Option<Lock>,
    pub refund_time: i64,
}
