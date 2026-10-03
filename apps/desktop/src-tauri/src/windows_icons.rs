use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::RPC_E_CHANGED_MODE,
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    },
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
    UI::{
        Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON},
        WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
    },
};

fn pixels(icon: HICON, background: u8) -> Option<Vec<u8>> {
    // A top-down DIB keeps row order consistent with PNG. Flush GDI before reading it.
    unsafe {
        let dc = CreateCompatibleDC(null_mut());
        if dc.is_null() {
            return None;
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 32,
                biHeight: -32,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = null_mut();
        let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        if bitmap.is_null() {
            DeleteDC(dc);
            return None;
        }
        let old = SelectObject(dc, bitmap);
        let bytes = std::slice::from_raw_parts_mut(bits.cast::<u8>(), 32 * 32 * 4);
        bytes.fill(background);
        let drawn = DrawIconEx(dc, 0, 0, icon, 32, 32, 0, null_mut(), DI_NORMAL) != 0;
        GdiFlush();
        let output = drawn.then(|| bytes.to_vec());
        SelectObject(dc, old);
        DeleteObject(bitmap);
        DeleteDC(dc);
        output
    }
}

pub fn extract(path: &str) -> Option<String> {
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let (black, white) = unsafe {
        let com = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
        if com < 0 && com != RPC_E_CHANGED_MODE {
            return None;
        }
        let mut info = SHFILEINFOW::default();
        let found = SHGetFileInfoW(
            path.as_ptr(),
            0,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        let result = if found != 0 && !info.hIcon.is_null() {
            let result = pixels(info.hIcon, 0).zip(pixels(info.hIcon, 255));
            DestroyIcon(info.hIcon);
            result
        } else {
            None
        };
        if com >= 0 {
            CoUninitialize();
        }
        result?
    };
    // Black/white rendering reconstructs straight alpha for both modern ARGB icons
    // and older mask icons, without black fringes on the light application theme.
    let rgba: Vec<u8> = black
        .chunks_exact(4)
        .zip(white.chunks_exact(4))
        .flat_map(|(black, white)| {
            let alpha = 255
                - (0..3)
                    .map(|i| white[i].saturating_sub(black[i]))
                    .max()
                    .unwrap();
            let channel = |i: usize| {
                if alpha == 0 {
                    0
                } else {
                    (u32::from(black[i]) * 255 / u32::from(alpha)).min(255) as u8
                }
            };
            [channel(2), channel(1), channel(0), alpha]
        })
        .collect();
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 32, 32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_windows_executable_produces_transparent_png_without_execution() {
        let path = format!("{}\\explorer.exe", std::env::var("SystemRoot").unwrap());
        let url = extract(&path).expect("Explorer icon");
        let bytes = STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut output = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut output).unwrap();
        assert_eq!(
            (info.width, info.height, info.color_type),
            (32, 32, png::ColorType::Rgba)
        );
        assert!(output.chunks_exact(4).any(|pixel| pixel[3] == 0));
        assert!(output
            .chunks_exact(4)
            .any(|pixel| pixel[3] > 0 && pixel[..3].iter().any(|v| *v > 0)));
        assert!(extract("Z:\\wifimeter-missing-icon-test\\missing.exe").is_none());
    }
}
