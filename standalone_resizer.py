import sys
import argparse
import os
import io
import requests
from PIL import Image

# --- CONFIG ---
# Using a hosted inference API (Flux or SDXL)
# "black-forest-labs/FLUX.1-schnell" is great but might not support Inpainting API directly yet.
# "stabilityai/stable-diffusion-xl-base-1.0" or dedicated inpainting endpoint is safer.
API_URL = "https://api-inference.huggingface.co/models/diffusers/stable-diffusion-xl-1.0-inpainting-0.1"

def api_resize(input_path, output_path, token, prompt="high quality, 8k, seamless extension, cinematic lighting"):
    print(f"🚀 Starting Cloud AI Resizer (Hugging Face API)...")
    
    if not token:
        print("❌ Error: No API Token provided.")
        return

    # 1. Load & Prepare Image Locally
    init_image = Image.open(input_path).convert("RGB")
    original_width, original_height = init_image.size
    target_width, target_height = 1920, 1080
    
    # Create Canvas
    canvas = Image.new("RGB", (target_width, target_height), (0, 0, 0))
    
    # Fit & Center
    ratio = min(target_width / original_width, target_height / original_height)
    new_w = int(original_width * ratio)
    new_h = int(original_height * ratio)
    resized_source = init_image.resize((new_w, new_h), Image.LANCZOS)
    
    paste_x = (target_width - new_w) // 2
    paste_y = (target_height - new_h) // 2
    canvas.paste(resized_source, (paste_x, paste_y))
    
    # Create Mask (White = Generate, Black = Keep)
    mask = Image.new("L", (target_width, target_height), 255)
    from PIL import ImageDraw
    mask_draw = ImageDraw.Draw(mask)
    blend_margin = 8
    mask_draw.rectangle([
        paste_x + blend_margin, 
        paste_y + blend_margin, 
        paste_x + new_w - blend_margin, 
        paste_y + new_h - blend_margin
    ], fill=0)

    # 2. Serialize Images for API
    # The HF Inference API for Inpainting usually expects:
    # inputs: prompt
    # parameters: ...
    # And images sent as base64 or multipart.
    # Actually, the easiest way for "diffusers" models on Inference API is usually raw bytes if it's img2img,
    # but for inpainting it can be tricky.
    # Let's use the 'huggingface_hub' InferenceClient if available, or raw requests.
    
    from huggingface_hub import InferenceClient
    client = InferenceClient(token=token)
    
    print("☁️  Sending to Hugging Face Cloud...")
    
    try:
        # Note: "black-forest-labs/FLUX.1-schnell" does NOT support inpainting via simple API yet.
        # We stick to SDXL Inpainting for reliable cloud API usage.
        # image_to_image is not enough; we need inpainting.
        # The Python client 'image_segmentation' etc doesn't map perfectly.
        # We will manually call the model endpoint that supports mask.
        
        # NOTE: Many HF free tier models have cold starts or timeouts.
        image = client.image_to_image(
            model="diffusers/stable-diffusion-xl-1.0-inpainting-0.1",
            prompt=prompt,
            image=canvas, 
            # The client usually handles 'mask_image' if the task supports it, 
            # but standard image_to_image might just be img2img.
            # Let's try passing the composed canvas + mask if possible?
            # Actually, the 'diffusers' endpoint usually accepts 'image' and 'mask_image'.
            # Let's try raw request for control.
        )
        # Wait, the python client is high level. Let's do raw request to ensure mask support.
        
        # Prepare buffers
        import base64
        def img_to_b64(img):
            buff = io.BytesIO()
            img.save(buff, format="PNG")
            return base64.b64encode(buff.getvalue()).decode("utf-8")

        payload = {
            "inputs": prompt,
            "image": img_to_b64(canvas),
            "mask_image": img_to_b64(mask),
            "parameters": {
                "num_inference_steps": 25,
                "guidance_scale": 7.5,
                "strength": 0.99
            }
        }
        
        response = requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {token}"},
            json=payload
        )
        
        if response.status_code != 200:
            print(f"❌ API Error {response.status_code}: {response.text}")
            # Fallback: Just save the canvas (black bars) so user gets SOMETHING
            canvas.save(output_path)
            return

        # 3. Decode Response
        result_image = Image.open(io.BytesIO(response.content))
        result_image.save(output_path)
        print(f"✅ Cloud Generation Complete! Saved to {output_path}")

    except Exception as e:
        print(f"❌ Cloud Error: {e}")
        canvas.save(output_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--token", required=True, help="Hugging Face API Token")
    parser.add_argument("--prompt", default="high quality, realistic, cinematic, seamless background extension")
    args = parser.parse_args()
    
    api_resize(args.input, args.output, args.token, args.prompt)
