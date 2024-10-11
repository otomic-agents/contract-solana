use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};
use solana_program::keccak;
use std::mem::size_of;

declare_id!("FAqaHQHgBFFX8fJB6fQUqNdc8zABV5pGVRdCt7fLLYVo");

const ADMIN_SETTINGS_SEED: &[u8] = b"settings";
const TOKEN_SETTINGS_SEED_PREFIX: &[u8] = b"token";

#[program]
pub mod obridge {
    use anchor_lang::system_program;

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey) -> Result<()> {
        ctx.accounts.admin_settings.admin = admin;
        Ok(())
    }

    pub fn change_admin(ctx: Context<ChangeAdmin>) -> Result<()> {
        ctx.accounts.admin_settings.admin = ctx.accounts.new_admin.key();
        Ok(())
    }

    pub fn set_fee_recepient(ctx: Context<SetFeeRecepient>) -> Result<()> {
        ctx.accounts.admin_settings.fee_recepient = ctx.accounts.fee_recepient.key();
        Ok(())
    }

    pub fn set_fee_rate(ctx: Context<SetFeeRate>, fee_rate_bp: u16) -> Result<()> {
        ctx.accounts.admin_settings.fee_rate_bp = fee_rate_bp;
        Ok(())
    }

    pub fn set_max_fee_for_token(
        ctx: Context<SetMaxFeeForToken>,
        _mint: Pubkey,
        max_fee: u64,
    ) -> Result<()> {
        ctx.accounts.token_settings.max_fee = max_fee;
        Ok(())
    }

    pub fn prepare(
        ctx: Context<Prepare>,
        _uuid: [u8; 32],
        to: Pubkey,
        sol_amount: u64,
        token_amount: u64,
        lock: Lock,
        _is_out: bool,
        _memo: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.from.key(),
            Errors::InvalidSender
        );

        require!(token_amount > 0, Errors::InvalidAmount);

        let timestamp = Clock::get()?.unix_timestamp;

        let timelock = if _is_out {
            lock.agreement_reached_time + 1 * lock.expected_single_step_time
        } else {
            lock.agreement_reached_time + 2 * lock.expected_single_step_time
        };
        require!(timestamp <= timelock, Errors::DeadlineExceeded);

        lock.check_refund_time()?;

        let fee_rate_bp = ctx.accounts.admin_settings.fee_rate_bp as u64;
        let mut sol_fee: u64 = 0;
        if sol_amount > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.from.to_account_info(),
                        to: ctx.accounts.escrow.to_account_info(),
                    },
                ),
                sol_amount,
            )?;

            sol_fee = sol_amount * fee_rate_bp / 10000;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.source.to_account_info(),
                    to: ctx.accounts.escrow_ata.to_account_info(),
                    authority: ctx.accounts.from.to_account_info(),
                },
            ),
            token_amount,
        )?;

        let mut token_fee = token_amount * fee_rate_bp / 10000;
        if ctx.accounts.token_settings.is_some() {
            let max_fee = ctx.accounts.token_settings.as_ref().unwrap().max_fee;
            if max_fee > 0 && token_fee > max_fee {
                token_fee = max_fee;
            }
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.from = ctx.accounts.from.key();
        escrow.to = to;
        escrow.token_program = ctx.accounts.token_program.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.source = ctx.accounts.source.key();
        escrow.escrow_ata = ctx.accounts.escrow_ata.key();
        escrow.sol_amount = sol_amount;
        escrow.token_amount = token_amount;
        escrow.sol_fee = sol_fee;
        escrow.token_fee = token_fee;
        escrow.lock = lock;
        Ok(())
    }

    pub fn confirm(
        ctx: Context<Confirm>,
        uuid: [u8; 32],
        preimage: [u8; 32],
        _is_out: bool,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let hash = keccak::hash(&preimage).0;
        let timestamp = Clock::get()?.unix_timestamp;

        escrow.lock.check_hashlock(&hash)?;

        if _is_out {
            // payer is the from account
            if ctx.accounts.payer.key() == ctx.accounts.from.key() {
                let timelock =
                    escrow.lock.agreement_reached_time + 3 * escrow.lock.expected_single_step_time;
                require!(timestamp <= timelock, Errors::DeadlineExceeded);
            } else {
                // payer is not the from account
                let start_timelock = escrow.lock.agreement_reached_time
                    + 3 * escrow.lock.expected_single_step_time
                    + 2 * escrow.lock.tolerant_single_step_time;
                let end_timelock = escrow.lock.agreement_reached_time
                    + 3 * escrow.lock.expected_single_step_time
                    + 3 * escrow.lock.tolerant_single_step_time;
                require!(
                    start_timelock <= timestamp && timestamp <= end_timelock,
                    Errors::DeadlineExceeded
                );
            }
        } else {
            // payer is the from account
            if ctx.accounts.payer.key() == ctx.accounts.from.key() {
                let timelock = escrow.lock.agreement_reached_time
                    + 3 * escrow.lock.expected_single_step_time
                    + 1 * escrow.lock.tolerant_single_step_time;
                require!(timestamp <= timelock, Errors::DeadlineExceeded);
            } else {
                // payer is not the from account
                let start_timelock = escrow.lock.agreement_reached_time
                    + 3 * escrow.lock.expected_single_step_time
                    + 1 * escrow.lock.tolerant_single_step_time;
                let end_timelock = escrow.lock.agreement_reached_time
                    + 3 * escrow.lock.expected_single_step_time
                    + 2 * escrow.lock.tolerant_single_step_time;
                require!(
                    start_timelock <= timestamp && timestamp <= end_timelock,
                    Errors::DeadlineExceeded
                );
            }
        }

        let seeds: &[&[&[u8]]] = &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.fee_destination.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                seeds,
            ),
            escrow.token_fee,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                seeds,
            ),
            escrow.token_amount - escrow.token_fee,
        )?;

        // close escrow ata account and transfer remaining tokens to "from" account
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_ata.to_account_info(),
                destination: ctx.accounts.from.to_account_info(),
                authority: escrow.to_account_info(),
            },
            seeds,
        ))?;

        // close escrow account
        let escrow_lamports = escrow.to_account_info().lamports();
        if escrow.sol_amount > 0 {
            ctx.accounts.fee_recepient.add_lamports(escrow.sol_fee)?;
            ctx.accounts
                .to
                .add_lamports(escrow.sol_amount - escrow.sol_fee)?;
            ctx.accounts
                .from
                .add_lamports(escrow_lamports - escrow.sol_amount)?;
        } else {
            ctx.accounts.from.add_lamports(escrow_lamports)?;
        }

        escrow.sub_lamports(escrow_lamports)?;
        escrow.to_account_info().assign(&system_program::ID);
        escrow.to_account_info().realloc(0, false)?;

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, uuid: [u8; 32], _is_out: bool) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let timestamp = Clock::get()?.unix_timestamp;

        require!(
            timestamp >= escrow.lock.earliest_refund_time,
            Errors::NotRefundable
        );

        let seeds: &[&[&[u8]]] = &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.source.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                seeds,
            ),
            escrow.token_amount,
        )?;

        // close escrow ata account and transfer remaining tokens to "from" account
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_ata.to_account_info(),
                destination: ctx.accounts.from.to_account_info(),
                authority: escrow.to_account_info(),
            },
            seeds,
        ))?;

        // close escrow account

        let escrow_lamports = escrow.to_account_info().lamports();
        ctx.accounts.from.add_lamports(escrow_lamports)?;

        escrow.sub_lamports(escrow_lamports)?;
        escrow.to_account_info().assign(&system_program::ID);
        escrow.to_account_info().realloc(0, false)?;

        Ok(())
    }
}

#[error_code]
pub enum Errors {
    #[msg("account mismatch")]
    AccountMismatch,
    #[msg("escrow closed")]
    EscrowClosed,
    #[msg("invalid amount")]
    InvalidAmount,
    #[msg("invalid fee rate")]
    InvalidFeeRate,
    #[msg("invalid sender")]
    InvalidSender,
    #[msg("invalid refund time")]
    InvalidRefundTime,
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
    pub agreement_reached_time: i64,
    pub expected_single_step_time: i64,
    pub tolerant_single_step_time: i64,
    pub earliest_refund_time: i64,
}

impl Lock {
    fn check_refund_time(&self) -> Result<()> {
        require!(
            self.earliest_refund_time
                > self.agreement_reached_time
                    + 3 * self.expected_single_step_time
                    + 3 * self.tolerant_single_step_time,
            Errors::InvalidRefundTime
        );
        Ok(())
    }

    fn check_hashlock(&self, hash: &[u8; 32]) -> Result<()> {
        require!(hash.eq(&self.hash), Errors::PreimageMismatch);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(init, payer = payer, space = size_of::<AdminSettings>() + 8, seeds = [ADMIN_SETTINGS_SEED], bump)]
    pub admin_settings: Account<'info, AdminSettings>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ChangeAdmin<'info> {
    pub admin: Signer<'info>,
    pub new_admin: Signer<'info>,

    #[account(mut, seeds = [ADMIN_SETTINGS_SEED], bump, has_one = admin @ Errors::AccountMismatch)]
    pub admin_settings: Account<'info, AdminSettings>,
}

#[derive(Accounts)]
pub struct SetFeeRecepient<'info> {
    pub admin: Signer<'info>,
    pub fee_recepient: Signer<'info>,

    #[account(mut, seeds = [ADMIN_SETTINGS_SEED], bump, has_one = admin @ Errors::AccountMismatch)]
    pub admin_settings: Account<'info, AdminSettings>,
}

#[derive(Accounts)]
#[instruction(value: u16)]
pub struct SetFeeRate<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [ADMIN_SETTINGS_SEED],
        bump,
        has_one = admin @ Errors::AccountMismatch,
        constraint = value < 10000 @ Errors::InvalidFeeRate,
    )]
    pub admin_settings: Account<'info, AdminSettings>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct SetMaxFeeForToken<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,

    #[account(seeds = [ADMIN_SETTINGS_SEED], bump, has_one = admin @ Errors::AccountMismatch)]
    pub admin_settings: Account<'info, AdminSettings>,
    #[account(
        init_if_needed,
        payer = payer,
        space = size_of::<TokenSettings>() + 8,
        seeds = [TOKEN_SETTINGS_SEED_PREFIX, &mint.to_bytes()],
        bump,
    )]
    pub token_settings: Account<'info, TokenSettings>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 32])]
pub struct Prepare<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub from: Signer<'info>,

    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    #[account(init, payer = payer, space = size_of::<Escrow>() + 8, seeds = [&uuid], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = escrow)]
    pub escrow_ata: Account<'info, TokenAccount>,

    #[account(seeds = [ADMIN_SETTINGS_SEED], bump)]
    pub admin_settings: Account<'info, AdminSettings>,
    #[account(seeds = [TOKEN_SETTINGS_SEED_PREFIX, &mint.key().to_bytes()], bump)]
    pub token_settings: Option<Account<'info, TokenSettings>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 32])]
pub struct Confirm<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub from: SystemAccount<'info>,
    /// CHECK: value recepient
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = escrow.mint, associated_token::authority = escrow.to)]
    pub destination: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = from @ Errors::AccountMismatch,
        has_one = to @ Errors::AccountMismatch,
        has_one = escrow_ata @ Errors::AccountMismatch,
        has_one = token_program @ Errors::AccountMismatch,
        constraint = escrow.token_amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Account<'info, TokenAccount>,

    #[account(seeds = [ADMIN_SETTINGS_SEED], bump, has_one = fee_recepient)]
    pub admin_settings: Account<'info, AdminSettings>,
    /// CHECK: fee recepient
    #[account(mut)]
    pub fee_recepient: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = escrow.mint, associated_token::authority = admin_settings.fee_recepient)]
    pub fee_destination: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 32])]
pub struct Refund<'info> {
    #[account(mut)]
    pub from: SystemAccount<'info>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = from @ Errors::AccountMismatch,
        has_one = source @ Errors::AccountMismatch,
        has_one = escrow_ata @ Errors::AccountMismatch,
        has_one = token_program @ Errors::AccountMismatch,
        constraint = escrow.token_amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct AdminSettings {
    pub admin: Pubkey,
    pub fee_recepient: Pubkey,
    pub fee_rate_bp: u16,
}

#[account]
pub struct TokenSettings {
    pub max_fee: u64,
}

#[account]
pub struct Escrow {
    pub from: Pubkey,
    pub to: Pubkey,
    pub token_program: Pubkey,
    pub mint: Pubkey,
    pub source: Pubkey,
    pub escrow_ata: Pubkey,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub sol_fee: u64,
    pub token_fee: u64,
    pub lock: Lock,
}
