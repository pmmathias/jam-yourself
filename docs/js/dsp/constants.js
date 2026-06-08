// Engine working sample rate and analysis hop -- mirrors the Python reference.
export const SR = 22050;
export const HOP = 256;
export const N_FFT = 1024;
export const ENV_FPS = SR / HOP; // ~86.13 onset-envelope frames per second
