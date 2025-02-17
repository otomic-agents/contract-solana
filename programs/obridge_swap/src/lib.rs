use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};
use std::mem::size_of;

declare_id!("DnSgZFH2hMgZ7bXmJUdcL8bgB1MgDpVtddNhwzZACTKQ");

const ADMIN_SETTINGS_SEED: &[u8] = b"settings";
const TOKEN_SETTINGS_SEED_PREFIX: &[u8] = b"token";

mod helpers {
    use super::*;
    use anchor_lang::system_program;

    pub fn handle_token_transfer<'info>(
        token_program: &Program<'info, Token>,
        from: &AccountInfo<'info>,
        to: &AccountInfo<'info>,
        authority: &AccountInfo<'info>,
        amount: u64,
        seeds: Option<&[&[&[u8]]]>,
    ) -> Result<()> {
        let transfer_ctx = CpiContext::new(
            token_program.to_account_info(),
            token::Transfer {
                from: from.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        );

        if let Some(seeds) = seeds {
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    transfer_ctx.accounts,
                    seeds,
                ),
                amount,
            )
        } else {
            token::transfer(transfer_ctx, amount)
        }
    }

    pub fn handle_sol_transfer<'info>(
        from: &AccountInfo<'info>,
        to: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        amount: u64,
    ) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                system_program.clone(),
                system_program::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn verify_token_settings(
        token: Option<&Account<Mint>>,
        token_settings: Option<&Account<TokenSettings>>,
        program_id: &Pubkey,
    ) -> Result<()> {
        if let Some(settings) = token_settings {
            let (expected_settings, _) = if let Some(token) = token {
                Pubkey::find_program_address(
                    &[
                        TOKEN_SETTINGS_SEED_PREFIX,
                        &token.to_account_info().key().to_bytes(),
                    ],
                    program_id,
                )
            } else {
                Pubkey::find_program_address(&[TOKEN_SETTINGS_SEED_PREFIX, &[0u8; 32]], program_id)
            };
            require!(
                settings.key() == expected_settings,
                Errors::InvalidTokenSettings
            );
        }
        Ok(())
    }

    pub fn calculate_fee(amount: u64, fee_rate_bp: u16, max_fee: Option<u64>) -> u64 {
        let mut fee = amount * fee_rate_bp as u64 / 10000;
        if let Some(max) = max_fee {
            if max > 0 && fee > max {
                fee = max;
            }
        }
        fee
    }

    pub fn close_escrow_account<'info>(
        escrow: &Account<'info, Escrow>,
        from: &AccountInfo<'info>,
        from_add_lamports: u64,
        escrow_minus_lamports: u64,
    ) -> Result<()> {
        from.add_lamports(from_add_lamports)?;
        escrow.sub_lamports(escrow_minus_lamports)?;
        escrow.to_account_info().assign(&system_program::ID);
        Ok(escrow.to_account_info().realloc(0, false)?)
    }
}

#[program]
pub mod obridge_swap {

    use super::*;
    use helpers::*;

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

    pub fn submit_swap(
        ctx: Context<SubmitSwap>,
        _uuid: [u8; 32],
        src_amount: u64,
        dst_amount: u64,
        lock: Lock,
        _memo: Vec<u8>,
    ) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.from.key(),
            Errors::InvalidSender
        );

        require!(src_amount > 0 && dst_amount > 0, Errors::InvalidAmount);

        let timestamp = Clock::get()?.unix_timestamp;
        require!(
            timestamp <= lock.agreement_reached_time + 1 * lock.step_time,
            Errors::DeadlineExceeded
        );

        // Verify token settings and calculate fees
        verify_token_settings(
            ctx.accounts.src_token.as_ref(),
            ctx.accounts.src_token_settings.as_ref(),
            &ctx.program_id,
        )?;
        verify_token_settings(
            ctx.accounts.dst_token.as_ref(),
            ctx.accounts.dst_token_settings.as_ref(),
            &ctx.program_id,
        )?;

        let fee_rate_bp = ctx.accounts.admin_settings.fee_rate_bp;
        let src_token_fee = calculate_fee(
            src_amount,
            fee_rate_bp,
            ctx.accounts.src_token_settings.as_ref().map(|s| s.max_fee),
        );
        let dst_token_fee = calculate_fee(
            dst_amount,
            fee_rate_bp,
            ctx.accounts.dst_token_settings.as_ref().map(|s| s.max_fee),
        );

        // Handle token transfers
        if ctx.accounts.src_token.is_some() {
            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.source.as_ref().unwrap().to_account_info(),
                &ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                &ctx.accounts.from.to_account_info(),
                src_amount,
                None,
            )?;
        } else {
            // Handle SOL transfer
            handle_sol_transfer(
                &ctx.accounts.from.to_account_info(),
                &ctx.accounts.escrow.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                src_amount,
            )?;
        }

        // Update escrow account
        let escrow = &mut ctx.accounts.escrow;
        escrow.from = ctx.accounts.from.key();
        escrow.to = ctx.accounts.to.key();
        escrow.src_amount = src_amount;
        escrow.dst_amount = dst_amount;
        escrow.src_token_fee = src_token_fee;
        escrow.dst_token_fee = dst_token_fee;
        escrow.lock = lock;
        escrow.src_token = ctx
            .accounts
            .src_token
            .as_ref()
            .map_or(Pubkey::new_from_array([0; 32]), |t| t.key());
        escrow.dst_token = ctx
            .accounts
            .dst_token
            .as_ref()
            .map_or(Pubkey::new_from_array([0; 32]), |t| t.key());

        Ok(())
    }

    pub fn confirm_swap(ctx: Context<ConfirmSwap>, uuid: [u8; 32]) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.to.key(),
            Errors::InvalidSender
        );

        let escrow = &mut ctx.accounts.escrow;
        let timestamp = Clock::get()?.unix_timestamp;

        require!(
            timestamp <= escrow.lock.agreement_reached_time + 2 * escrow.lock.step_time,
            Errors::DeadlineExceeded
        );

        let zero_pubkey = Pubkey::new_from_array([0; 32]);
        let seeds: &[&[&[u8]]] = &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]];

        // Handle destination token transfers (SOL or SPL)
        if escrow.dst_token == zero_pubkey {
            // Handle SOL transfers
            handle_sol_transfer(
                &ctx.accounts.to.to_account_info(),
                &ctx.accounts.fee_recepient.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                escrow.dst_token_fee,
            )?;
            handle_sol_transfer(
                &ctx.accounts.to.to_account_info(),
                &ctx.accounts.from.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                escrow.dst_amount - escrow.dst_token_fee,
            )?;
        } else {
            // Handle SPL token transfers
            require!(
                ctx.accounts.token_program.is_some()
                    && ctx.accounts.to_source.is_some()
                    && ctx.accounts.dst_fee_destination.is_some()
                    && ctx.accounts.from_destination.is_some(),
                Errors::AccountMismatch
            );

            // Transfer fee
            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.to_source.as_ref().unwrap().to_account_info(),
                &ctx.accounts
                    .dst_fee_destination
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                &ctx.accounts.to.to_account_info(),
                escrow.dst_token_fee,
                Some(seeds),
            )?;

            // Transfer amount minus fee
            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.to_source.as_ref().unwrap().to_account_info(),
                &ctx.accounts
                    .from_destination
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                &ctx.accounts.to.to_account_info(),
                escrow.dst_amount - escrow.dst_token_fee,
                Some(seeds),
            )?;
        }

        // Handle source token transfers (SOL or SPL)
        if escrow.src_token == zero_pubkey {
            ctx.accounts
                .fee_recepient
                .add_lamports(escrow.src_token_fee)?;
            ctx.accounts
                .to
                .add_lamports(escrow.src_amount - escrow.src_token_fee)?;

            let escrow_lamports = escrow.to_account_info().lamports();
            close_escrow_account(
                escrow,
                &ctx.accounts.from.to_account_info(),
                escrow_lamports - escrow.src_amount,
                escrow_lamports,
            )?;
        } else {
            require!(
                ctx.accounts.token_program.is_some()
                    && ctx.accounts.escrow_ata.is_some()
                    && ctx.accounts.src_fee_destination.is_some()
                    && ctx.accounts.to_destination.is_some(),
                Errors::AccountMismatch
            );

            // Transfer fee and remaining amount
            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                &ctx.accounts
                    .src_fee_destination
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                &escrow.to_account_info(),
                escrow.src_token_fee,
                Some(seeds),
            )?;

            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                &ctx.accounts
                    .to_destination
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                &escrow.to_account_info(),
                escrow.src_amount - escrow.src_token_fee,
                Some(seeds),
            )?;

            // Close escrow ATA account
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts
                    .token_program
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                    destination: ctx.accounts.from.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                seeds,
            ))?;

            // Close escrow account
            let escrow_lamports = escrow.to_account_info().lamports();
            close_escrow_account(
                escrow,
                &ctx.accounts.from.to_account_info(),
                escrow_lamports,
                escrow_lamports,
            )?;
        }

        Ok(())
    }

    pub fn refund_swap(ctx: Context<RefundSwap>, uuid: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let timestamp = Clock::get()?.unix_timestamp;

        require!(
            timestamp > escrow.lock.agreement_reached_time + 2 * escrow.lock.step_time,
            Errors::NotRefundable
        );

        let zero_pubkey = Pubkey::new_from_array([0; 32]);
        let seeds: &[&[&[u8]]] = &[&[&uuid, &[Pubkey::find_program_address(&[&uuid], &id()).1]]];

        if escrow.src_token != zero_pubkey {
            require!(
                ctx.accounts.token_program.is_some()
                    && ctx.accounts.escrow_ata.is_some()
                    && ctx.accounts.source.is_some(),
                Errors::AccountMismatch
            );

            // Transfer all tokens back
            handle_token_transfer(
                ctx.accounts.token_program.as_ref().unwrap(),
                &ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                &ctx.accounts.source.as_ref().unwrap().to_account_info(),
                &escrow.to_account_info(),
                escrow.src_amount,
                Some(seeds),
            )?;

            // Close escrow ATA account
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts
                    .token_program
                    .as_ref()
                    .unwrap()
                    .to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_ata.as_ref().unwrap().to_account_info(),
                    destination: ctx.accounts.from.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                seeds,
            ))?;
        }

        // Close escrow account and refund SOL
        let escrow_lamports = escrow.to_account_info().lamports();
        close_escrow_account(
            escrow,
            &ctx.accounts.from.to_account_info(),
            escrow_lamports,
            escrow_lamports,
        )?;

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
    #[msg("not SOL token")]
    NotSOLToken,
    #[msg("invalid token settings")]
    InvalidTokenSettings,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Lock {
    pub agreement_reached_time: i64,
    pub step_time: i64,
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
pub struct SubmitSwap<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub from: Signer<'info>,
    pub to: SystemAccount<'info>,

    pub src_token: Option<Account<'info, Mint>>,
    #[account(mut)]
    pub source: Option<Account<'info, TokenAccount>>,

    pub dst_token: Option<Account<'info, Mint>>,

    #[account(init, payer = payer, space = size_of::<Escrow>() + 8, seeds = [&uuid], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = payer, associated_token::mint = src_token, associated_token::authority = escrow)]
    pub escrow_ata: Option<Account<'info, TokenAccount>>,

    #[account(seeds = [ADMIN_SETTINGS_SEED], bump)]
    pub admin_settings: Account<'info, AdminSettings>,
    pub src_token_settings: Option<Account<'info, TokenSettings>>,
    pub dst_token_settings: Option<Account<'info, TokenSettings>>,

    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 32])]
pub struct ConfirmSwap<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub from: SystemAccount<'info>,
    #[account(mut, associated_token::mint = escrow.dst_token, associated_token::authority = escrow.from)]
    pub from_destination: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub to: Signer<'info>,
    #[account(mut, associated_token::mint = escrow.dst_token, associated_token::authority = escrow.to)]
    pub to_source: Option<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = escrow.src_token, associated_token::authority = escrow.to)]
    pub to_destination: Option<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = from @ Errors::AccountMismatch,
        has_one = to @ Errors::AccountMismatch,
        constraint = escrow.src_amount > 0 @ Errors::EscrowClosed,
        constraint = escrow.dst_amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Option<Account<'info, TokenAccount>>,

    #[account(seeds = [ADMIN_SETTINGS_SEED], bump, has_one = fee_recepient)]
    pub admin_settings: Account<'info, AdminSettings>,
    /// CHECK: fee recepient
    #[account(mut)]
    pub fee_recepient: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = escrow.src_token, associated_token::authority = admin_settings.fee_recepient)]
    pub src_fee_destination: Option<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = escrow.dst_token, associated_token::authority = admin_settings.fee_recepient)]
    pub dst_fee_destination: Option<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,
}

#[derive(Accounts)]
#[instruction(uuid: [u8; 32])]
pub struct RefundSwap<'info> {
    #[account(mut)]
    pub from: SystemAccount<'info>,
    #[account(mut)]
    pub source: Option<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds=[&uuid],
        bump,
        has_one = from @ Errors::AccountMismatch,
        constraint = escrow.src_amount > 0 @ Errors::EscrowClosed,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub escrow_ata: Option<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Option<Program<'info, Token>>,
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
    pub src_token: Pubkey,
    pub dst_token: Pubkey,
    pub src_amount: u64,
    pub dst_amount: u64,
    pub src_token_fee: u64,
    pub dst_token_fee: u64,
    pub lock: Lock,
}
