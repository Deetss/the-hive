import { AnimatedSprite, Container, Graphics, Sprite, Texture } from 'pixi.js';
import {
  type HiveKitStatus,
  getHiveBeeStatusFrames,
  getHiveStatusChipTexture
} from './hiveKit';

export type Direction = 'down' | 'up' | 'right' | 'left';
export type AnimState = 'walk' | 'type' | 'read' | 'idle';

// Output rows from SpriteAdapter: down=0, up=1, right=2 (left = flipped right)
const DIRECTION_ROW: Record<Direction, number> = {
  down: 0,
  up: 1,
  right: 2,
  left: 2,
};

const ANIM_FRAMES: Record<AnimState, number[]> = {
  walk: [0, 1, 2, 1],
  type: [0, 1, 2, 1],
  read: [0, 1, 2, 1],
  idle: [0],
};

const CHAR_SCALE = 1.08;

/** Character Sprite supporting standard procedural sprites and animated Hive Kit atlas bees. */
export class CharacterSprite {
  readonly container: Container;
  private sprite: AnimatedSprite;
  private chipSprite: Sprite;
  private frames: Texture[][];
  private currentDirection: Direction = 'down';
  private currentAnim: AnimState = 'idle';
  private frameSpeed = 0.15;
  private frameW: number;
  private frameH: number;
  private cropMask: Graphics | null = null;
  private continuous: boolean;
  private isHiveKit: boolean = false;
  private currentHiveStatus: HiveKitStatus = 'idle';

  constructor(frames: Texture[][], continuous = false, isHiveKit = false) {
    this.frames = frames;
    this.continuous = continuous;
    this.isHiveKit = isHiveKit;
    this.container = new Container();

    const initialFrames = continuous ? frames[0] : this.getFrames('down', 'idle');
    this.sprite = new AnimatedSprite(initialFrames);
    this.sprite.anchor.set(0.5, 1);
    this.sprite.animationSpeed = continuous ? 0.28 : this.frameSpeed;
    this.sprite.play();

    this.frameW = this.sprite.texture.frame.width || this.sprite.width || 24;
    this.frameH = this.sprite.texture.frame.height || this.sprite.height || 24;

    this.chipSprite = new Sprite();
    this.chipSprite.anchor.set(0.5, 1);
    this.chipSprite.position.set(0, -22); // 15px above the 16×16 bee cell
    this.chipSprite.visible = false;

    this.container.addChild(this.sprite);
    this.container.addChild(this.chipSprite);
    this.container.scale.set(CHAR_SCALE);

    if (isHiveKit) {
      void this.setHiveKitStatus('idle', 'down');
    }
  }

  setSeatedCrop(cropPx: number): void {
    if (cropPx <= 0) {
      if (this.cropMask) {
        this.sprite.mask = null;
        this.cropMask.visible = false;
      }
      return;
    }
    if (!this.cropMask) {
      this.cropMask = new Graphics();
      this.container.addChild(this.cropMask);
    }
    const w = this.frameW;
    const h = this.frameH;
    this.cropMask.clear();
    this.cropMask
      .rect(-w / 2 - 2, -h - 2, w + 4, h - cropPx + 2)
      .fill(0xffffff);
    this.cropMask.visible = true;
    this.sprite.mask = this.cropMask;
  }

  private getFrames(direction: Direction, anim: AnimState): Texture[] {
    const row = DIRECTION_ROW[direction];
    return ANIM_FRAMES[anim].map((col) => this.frames[row][col % this.frames[row].length]);
  }

  setAnimation(anim: AnimState, direction: Direction): void {
    if (this.isHiveKit) {
      const kitStatus = anim === 'walk' ? 'moving' : this.currentHiveStatus;
      void this.setHiveKitStatus(kitStatus, direction);
      return;
    }

    if (anim === this.currentAnim && direction === this.currentDirection) return;
    this.currentAnim = anim;
    this.currentDirection = direction;

    if (this.continuous) {
      this.sprite.scale.x = direction === 'left' ? -1 : 1;
      return;
    }

    this.sprite.textures = this.getFrames(direction, anim);
    this.sprite.scale.x = direction === 'left' ? -1 : 1;
    this.sprite.animationSpeed = anim === 'walk' ? 0.15 : anim === 'idle' ? 0.08 : 0.06;
    this.sprite.play();
  }

  async setHiveKitStatus(status: HiveKitStatus, direction: Direction): Promise<void> {
    this.isHiveKit = true;
    const changed = status !== this.currentHiveStatus || direction !== this.currentDirection;
    this.currentHiveStatus = status;
    this.currentDirection = direction;

    if (changed || this.sprite.textures.length <= 1) {
      const dirKey = direction === 'left' ? 'right' : direction;
      const textures = await getHiveBeeStatusFrames(status, dirKey);
      this.sprite.textures = textures;
      this.sprite.scale.x = direction === 'left' ? -1 : 1;

      // Kit animation timing: 12fps base (0.20), moving (0.35), blocked fast shake (0.75)
      this.sprite.animationSpeed = status === 'moving' ? 0.35 : status === 'blocked' ? 0.75 : 0.20;
      this.sprite.play();

      const chipTex = await getHiveStatusChipTexture(status);
      this.chipSprite.texture = chipTex;
      this.chipSprite.visible = true;
    }
  }

  setChipVisible(visible: boolean): void {
    this.chipSprite.visible = visible;
  }

  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.container.y = y;
  }

  setAlpha(alpha: number): void {
    this.container.alpha = alpha;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
