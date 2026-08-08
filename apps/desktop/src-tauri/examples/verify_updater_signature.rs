use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let installer = args.next().ok_or("installer path is required")?;
    let signature = args.next().ok_or("signature path is required")?;
    let public_key = args.next().ok_or("public key path is required")?;
    if args.next().is_some() {
        return Err("expected installer, signature, and public key paths".into());
    }

    PublicKey::from_file(public_key)?.verify(
        &fs::read(&installer)?,
        &Signature::from_file(signature)?,
        true,
    )?;
    println!(
        "Verified updater signature for {}",
        installer.to_string_lossy()
    );
    Ok(())
}
