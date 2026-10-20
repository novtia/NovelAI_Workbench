//! 装配：把事件库、投影器和各个上下文的服务拼起来（对应 Python 的 `create_app`）。

use crate::contexts::gallery::application::{ensure_default_album, ensure_single_artist_album, GalleryService};
use crate::contexts::gallery::migrate::migrate_legacy;
use crate::contexts::gallery::projectors::GalleryProjector;
use crate::contexts::generation::application::GenerationService;
use crate::contexts::generation::nai_client::{NaiGateway, TokenVault};
use crate::contexts::generation::projectors::GenerationProjector;
use crate::contexts::identity::IdentityProjector;
use crate::contexts::lottery::application::LotteryService;
use crate::contexts::lottery::projectors::LotteryProjector;
use crate::contexts::settings::application::SettingsService;
use crate::contexts::settings::projectors::SettingsProjector;
use crate::kernel::blobs::BlobStore;
use crate::kernel::bus::{Kernel, Projector};
use crate::kernel::store::EventStore;
use crate::kernel::Res;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 投影器的顺序要和 Python 版一致（同一事件里先后写入互相有依赖）。
pub fn projectors() -> Vec<Box<dyn Projector>> {
    vec![
        Box::new(GalleryProjector),
        Box::new(LotteryProjector),
        Box::new(GenerationProjector),
        Box::new(IdentityProjector),
        Box::new(SettingsProjector),
    ]
}

pub struct Services {
    pub data_dir: PathBuf,
    pub kernel: Arc<Kernel>,
    pub gallery: Arc<GalleryService>,
    pub lottery: Arc<LotteryService>,
    pub settings: Arc<SettingsService>,
    pub generation: Arc<GenerationService>,
}

pub fn build(data_dir: &Path) -> Res<Services> {
    std::fs::create_dir_all(data_dir)?;
    let store = EventStore::open(&data_dir.join("events.sqlite"))?;
    let blobs = BlobStore::new(&data_dir.join("blobs"))?;
    let kernel = Arc::new(Kernel { store, blobs, projectors: projectors() });
    let vault = Arc::new(TokenVault::new(data_dir.join("secrets").join("nai.token")));
    let gallery = Arc::new(GalleryService::new(kernel.clone()));
    let lottery = Arc::new(LotteryService::new(kernel.clone(), gallery.clone()));
    let settings = Arc::new(SettingsService::new(kernel.clone()));

    {
        let s = settings.clone();
        lottery.set_default_controls(Arc::new(move || s.section("lottery")));
    }
    {
        let s = settings.clone();
        kernel.blobs.set_thumb_provider(Arc::new(move || {
            (
                s.value_i64("gallery", "thumbSize", 420).max(1) as u32,
                s.value_i64("gallery", "thumbQuality", 82).clamp(1, 100) as u32,
            )
        }));
    }
    let gateway = Arc::new(NaiGateway::new(vault.clone()));
    {
        let s = settings.clone();
        gateway.set_timeout_provider(Arc::new(move || s.value_f64("generation", "timeoutSec", 180.0)));
        let s = settings.clone();
        gateway.set_base_url_provider(Arc::new(move || {
            s.value("account", "gatewayUrl").as_str().unwrap_or("").to_string()
        }));
    }
    let generation = Arc::new(GenerationService::new(
        kernel.clone(),
        gallery.clone(),
        gateway,
        vault,
        settings.clone(),
    ));
    Ok(Services { data_dir: data_dir.to_path_buf(), kernel, gallery, lottery, settings, generation })
}

/// 启动时的数据准备：空库时从旧版 `ddd/data` 迁入，并保证默认收藏夹存在。
pub fn prepare(services: &Services, legacy_dir: Option<&Path>) -> Res<()> {
    if !services.kernel.store.has_events()? {
        if let Some(dir) = legacy_dir {
            if dir.join("gallery.db").is_file() {
                migrate_legacy(&services.gallery, dir)?;
            }
        }
    }
    ensure_defaults(services)
}

/// 保证默认收藏夹和单画师收藏夹存在（启动时、导入数据库后都要补一遍）。
pub fn ensure_defaults(services: &Services) -> Res<()> {
    ensure_default_album(&services.gallery)?;
    ensure_single_artist_album(&services.gallery)?;
    Ok(())
}
