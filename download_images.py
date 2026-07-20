#!/usr/bin/env python3
"""
脚本用途：下载outline.html和dqi.html中的远程图片，并更新HTML文件中的引用
"""

import os
import re
import requests
from pathlib import Path
from urllib.parse import urlparse

# 定义基本路径
workspace_root = "/Users/yuehanzhang514/Documents/GitHub/John-Yuehanzhang.github.io"
files_dir = os.path.join(workspace_root, "files")
images_dir = os.path.join(files_dir, "images")

# 创建图片目录
os.makedirs(images_dir, exist_ok=True)
print(f"✓ 创建图片目录: {images_dir}")

# outline.html中的远程图片
outline_images = [
    "http://106.55.147.46/wp-content/uploads/2025/10/image-1.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-10.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-1024x565.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-11-1024x525.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-12.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-13-1024x685.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-14-1024x557.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-15-1024x628.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-16-1024x263.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-17-1024x362.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-18-1024x504.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-2-1024x517.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-3-1024x502.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-5.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-6-1024x568.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-7-1024x335.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-8.png",
    "http://106.55.147.46/wp-content/uploads/2025/10/image-9-1024x500.png",
]

# dqi.html中的远程图片
dqi_images = [
    "https://johnyuehanz.site/wp-content/uploads/2025/11/0881d5befca44b6a4803d3e0463107ec-237x300.png",
    "https://johnyuehanz.site/wp-content/uploads/2025/11/b14be902bc207fa96a5a8842df85c2e4-300x39.png",
    "https://johnyuehanz.site/wp-content/uploads/2025/11/bbfcf3a96e5f0ccbc6cba5f43a45d854-300x197.png",
    "https://johnyuehanz.site/wp-content/uploads/2025/11/dd8ab13251cb3d604f0d43487f6dd406-300x240.png",
]

all_images = outline_images + dqi_images

# 下载图片函数
def download_image(url, save_path):
    """下载图片"""
    try:
        print(f"  下载: {url}")
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        with open(save_path, 'wb') as f:
            f.write(response.content)
        print(f"  ✓ 保存到: {save_path}")
        return True
    except Exception as e:
        print(f"  ✗ 错误: {e}")
        return False

# 下载所有图片
print("\n开始下载图片...")
downloaded_mapping = {}  # 记录URL到本地文件名的映射

for url in all_images:
    filename = os.path.basename(urlparse(url).path)
    save_path = os.path.join(images_dir, filename)
    
    if os.path.exists(save_path):
        print(f"  已存在: {filename}")
        downloaded_mapping[url] = f"images/{filename}"
    else:
        if download_image(url, save_path):
            downloaded_mapping[url] = f"images/{filename}"

print(f"\n✓ 共下载{len(downloaded_mapping)}张图片")

# 更新HTML文件函数
def update_html_file(html_file, image_mapping):
    """更新HTML文件中的图片链接"""
    print(f"\n更新文件: {html_file}")
    
    with open(html_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # 替换所有远程URL为本地路径
    for remote_url, local_path in image_mapping.items():
        # 替换src属性中的URL
        content = content.replace(f'src="{remote_url}"', f'src="{local_path}"')
        # 也替换srcset中的URL（保留其他srcset条目）
        # 这需要更复杂的正则表达式处理
        content = re.sub(
            rf'({remote_url.replace(".", r"\.")})\s+(\d+w)',
            rf'{local_path} \2',
            content
        )
    
    if content != original_content:
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"✓ 文件已更新")
    else:
        print(f"⚠ 文件无需更新")

# 更新两个HTML文件
outline_file = os.path.join(files_dir, "outline.html")
dqi_file = os.path.join(files_dir, "dqi.html")

print("\n" + "="*60)
print("更新HTML文件中的图片引用")
print("="*60)

update_html_file(outline_file, downloaded_mapping)
update_html_file(dqi_file, downloaded_mapping)

print("\n" + "="*60)
print("✓ 完成！所有图片已下载到本地，HTML文件已更新")
print("="*60)
